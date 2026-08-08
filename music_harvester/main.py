from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from music_harvester.config_loader import default_config_dir, load_yaml
from music_harvester.db.store import Store
from music_harvester.engine.dedupe import dedupe_candidates
from music_harvester.engine.bridge import bridge_discover
from music_harvester.engine.explain import markdown_table, rejected_markdown
from music_harvester.engine.filter import apply_vetoes
from music_harvester.engine.normalize import split_artist_track
from music_harvester.engine.score import score_candidates
from music_harvester.engine.sequence import sequence_playlist
from music_harvester.env import load_env
from music_harvester.http import ApiError
from music_harvester.models import Candidate, SourceConfig
from music_harvester.resolvers.spotify_resolver import SpotifyResolver
from music_harvester.sources import SourceUnavailable, adapter_for
from music_harvester.sources.spotify import SpotifyClient

DB_PATH = Path("data/music_harvester.sqlite")
OUTPUT_DIR = Path("output")
FINAL_JSON = OUTPUT_DIR / "final_playlist.json"


def main(argv: list[str] | None = None) -> int:
    load_env()
    parser = build_parser()
    args = parser.parse_args(argv)
    store = Store(Path(args.db))
    store.init()
    return args.func(args, store)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="music-harvester")
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--config-dir", default=str(default_config_dir()))
    sub = parser.add_subparsers(required=True)

    ingest = sub.add_parser("ingest")
    ingest.add_argument("--source")
    ingest.set_defaults(func=cmd_ingest)

    import_text = sub.add_parser("import-text")
    import_text.add_argument("--name", required=True)
    import_text.add_argument("--file")
    import_text.add_argument("--text")
    import_text.add_argument("--weight", type=float, default=1.0)
    import_text.set_defaults(func=cmd_import_text)

    candidates = sub.add_parser("candidates")
    candidates.add_argument("--limit", type=int, default=40)
    candidates.set_defaults(func=cmd_candidates)

    generate = sub.add_parser("generate")
    generate.add_argument("--mode", default="balanced_discovery")
    generate.add_argument("--length", type=int)
    generate.add_argument("--from-bridge", nargs="+")
    generate.add_argument("--source-url", action="append", default=[])
    generate.add_argument("--file", action="append", default=[])
    generate.add_argument("--text", action="append", default=[])
    generate.set_defaults(func=cmd_generate)

    bridge = sub.add_parser("bridge-discover")
    bridge.add_argument("--artists", nargs="+", default=[])
    bridge.add_argument("--tracks", nargs="+", default=[])
    bridge.add_argument("--source-url", action="append", default=[])
    bridge.add_argument("--file", action="append", default=[])
    bridge.add_argument("--text", action="append", default=[])
    bridge.add_argument("--search-limit", type=int, default=10)
    bridge.set_defaults(func=cmd_bridge_discover)

    create_seeds = sub.add_parser("create-seeds")
    add_discovery_input_args(create_seeds)
    create_seeds.add_argument("--length", type=int, default=30)
    create_seeds.add_argument("--thorough", action="store_true")
    create_seeds.add_argument("--search-limit", type=int, default=0)
    create_seeds.set_defaults(func=cmd_create_seeds)

    discover_seeds = sub.add_parser("discover-from-seeds")
    discover_seeds.add_argument("--artists", nargs="+", default=[])
    discover_seeds.add_argument("--tracks", nargs="+", default=[])
    discover_seeds.add_argument("--length", type=int, default=40)
    discover_seeds.add_argument("--search-limit", type=int, default=10)
    discover_seeds.set_defaults(func=cmd_discover_from_seeds)

    explain = sub.add_parser("explain")
    explain.add_argument("track")
    explain.set_defaults(func=cmd_explain)

    write = sub.add_parser("write-spotify")
    write.add_argument("--playlist-name", required=True)
    write.add_argument("--public", action="store_true")
    write.add_argument("--yes", action="store_true")
    write.set_defaults(func=cmd_write_spotify)

    run = sub.add_parser("run")
    run.add_argument("--mode", default="balanced_discovery")
    run.add_argument("--length", type=int)
    run.add_argument("--playlist-name", default="qrator finds")
    run.add_argument("--public", action="store_true")
    run.add_argument("--yes", action="store_true")
    run.set_defaults(func=cmd_run)

    return parser


def add_discovery_input_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--artists", nargs="+", default=[])
    parser.add_argument("--tracks", nargs="+", default=[])
    parser.add_argument("--source-url", action="append", default=[])
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--text", action="append", default=[])


def cmd_ingest(args: argparse.Namespace, store: Store) -> int:
    sources = load_sources(Path(args.config_dir) / "sources.yaml")
    wanted_source = getattr(args, "source", None)
    if wanted_source:
        sources = [source for source in sources if source.name == wanted_source]
        if not sources:
            print(f"No source named {wanted_source}.")
            return 1

    total = 0
    for source in sources:
        if "..." in source.locator:
            print(f"skipped {source.name}: placeholder URL")
            continue
        source_id = store.upsert_source(source)
        try:
            tracks = adapter_for(source).harvest()
            count = store.add_raw_tracks(source_id, tracks)
            total += count
            print(f"ingested {count:4d} tracks from {source.name}")
        except (SourceUnavailable, ApiError, OSError) as exc:
            store.add_error(source.name, str(exc), source_id)
            print(f"skipped {source.name}: {exc}")
    print(f"done: {total} raw tracks harvested")
    return 0


def cmd_import_text(args: argparse.Namespace, store: Store) -> int:
    if bool(args.file) == bool(args.text):
        print("Provide exactly one of --file or --text.")
        return 1
    if args.file:
        source = SourceConfig(
            name=args.name,
            platform="text",
            source_type="text_import",
            url=args.file,
            weight=args.weight,
            category="pasted_text",
        )
    else:
        source = SourceConfig(
            name=args.name,
            platform="manual",
            source_type="manual_seed",
            url=args.text,
            weight=args.weight,
            category="pasted_text",
        )
    source_id = store.upsert_source(source)
    try:
        count = store.add_raw_tracks(source_id, adapter_for(source).harvest())
    except (SourceUnavailable, ApiError, OSError) as exc:
        store.add_error(source.name, str(exc), source_id)
        print(f"failed {source.name}: {exc}")
        return 1
    print(f"imported {count} candidates from {source.name}")
    return 0


def cmd_candidates(args: argparse.Namespace, store: Store) -> int:
    candidates, _ = build_candidates(store, Path(args.config_dir), args.limit)
    print(markdown_table(candidates[: args.limit]))
    return 0


def cmd_generate(args: argparse.Namespace, store: Store) -> int:
    mode = args.mode
    if args.from_bridge:
        result = bridge_discover(
            store,
            artists=args.from_bridge,
            tracks=[],
            source_urls=args.source_url,
            files=args.file,
            texts=args.text,
            search_limit=10,
        )
        print(
            f"bridge discovery run {result.bridge_run_id}: checked {result.sources_checked}, "
            f"ingested {result.sources_ingested}, high-confidence {result.high_confidence_sources}"
        )
        for note in result.discovery_notes:
            print(f"note: {note}")
        mode = "bridge_discovery"
    selected, rejected, candidates = generate_playlist(store, Path(args.config_dir), mode, args.length)
    write_outputs(store, selected, rejected, candidates, bridge=True if args.from_bridge else False)
    print(markdown_table(selected))
    print(f"saved {OUTPUT_DIR / 'candidates.json'}")
    print(f"saved {OUTPUT_DIR / 'final_playlist.md'}")
    print(f"saved {OUTPUT_DIR / 'final_spotify_playlist.md'}")
    print(f"saved {OUTPUT_DIR / 'source_report.md'}")
    print(f"saved {OUTPUT_DIR / 'rejected.md'}")
    return 0


def cmd_bridge_discover(args: argparse.Namespace, store: Store) -> int:
    if not args.artists and not args.tracks:
        print("Provide --artists or --tracks seeds.")
        return 1
    result = bridge_discover(
        store,
        artists=args.artists,
        tracks=args.tracks,
        source_urls=args.source_url,
        files=args.file,
        texts=args.text,
        search_limit=args.search_limit,
    )
    candidates, rejected = build_candidates(store, Path(args.config_dir), None)
    write_bridge_outputs(candidates, rejected)
    print(
        f"bridge discovery run {result.bridge_run_id}: checked {result.sources_checked}, "
        f"ingested {result.sources_ingested}, high-confidence {result.high_confidence_sources}"
    )
    for note in result.discovery_notes:
        print(f"note: {note}")
    print(f"saved {OUTPUT_DIR / 'bridge_sources.md'}")
    print(f"saved {OUTPUT_DIR / 'bridge_candidates.json'}")
    return 0


def cmd_create_seeds(args: argparse.Namespace, store: Store) -> int:
    if not args.artists and not args.tracks and not args.source_url and not args.file and not args.text:
        print("Provide seeds, source URLs, files, or text.")
        return 1
    if args.thorough:
        os.environ["QRATOR_SOURCE_PROCESSING"] = "thorough"
    result = bridge_discover(
        store,
        artists=args.artists,
        tracks=args.tracks,
        source_urls=args.source_url,
        files=args.file,
        texts=args.text,
        search_limit=max(0, min(args.search_limit, 10)),
    )
    selected, rejected, candidates = generate_playlist(store, Path(args.config_dir), "balanced_discovery", args.length)
    write_outputs(store, selected, rejected, candidates, bridge=False)
    print(markdown_table(selected))
    print(
        f"seed creation run {result.bridge_run_id}: checked {result.sources_checked}, "
        f"ingested {result.sources_ingested}"
    )
    for note in result.discovery_notes:
        print(f"note: {note}")
    print(f"saved {OUTPUT_DIR / 'final_playlist.md'}")
    print(f"saved {OUTPUT_DIR / 'final_playlist.json'}")
    return 0


def cmd_discover_from_seeds(args: argparse.Namespace, store: Store) -> int:
    if not args.artists and not args.tracks:
        print("Provide --artists or --tracks seeds.")
        return 1
    result = bridge_discover(
        store,
        artists=args.artists,
        tracks=args.tracks,
        source_urls=[],
        files=[],
        texts=[],
        search_limit=args.search_limit,
    )
    selected, rejected, candidates = generate_playlist(store, Path(args.config_dir), "bridge_discovery", args.length)
    write_outputs(store, selected, rejected, candidates, bridge=True)
    print(markdown_table(selected))
    print(
        f"seed discovery run {result.bridge_run_id}: checked {result.sources_checked}, "
        f"ingested {result.sources_ingested}, high-confidence {result.high_confidence_sources}"
    )
    for note in result.discovery_notes:
        print(f"note: {note}")
    print(f"saved {OUTPUT_DIR / 'final_playlist.md'}")
    print(f"saved {OUTPUT_DIR / 'final_playlist.json'}")
    return 0


def cmd_explain(args: argparse.Namespace, store: Store) -> int:
    parsed = split_artist_track(args.track)
    candidates, rejected = build_candidates(store, Path(args.config_dir), None)
    pool = candidates + rejected
    match = find_track(pool, parsed, args.track)
    if not match:
        print("No matching track found.")
        return 1
    status = f"Rejected: {match.rejection_reason}" if match.rejected else f"Score: {match.score:.2f}"
    print(f"{match.artist} - {match.title}")
    print(status)
    print(match.why)
    print(f"Sources: {', '.join(match.sources)}")
    return 0


def cmd_write_spotify(args: argparse.Namespace, store: Store) -> int:
    if not FINAL_JSON.exists():
        print("No generated playlist found. Run generate first.")
        return 1
    selected = [candidate_from_json(item) for item in json.loads(FINAL_JSON.read_text(encoding="utf-8"))]
    playlist_id = write_spotify_playlist(selected, args.playlist_name, args.public, args.yes)
    track_ids = store.existing_track_ids([item.id for item in selected])
    store.record_run(args.playlist_name, "manual", True, playlist_id, track_ids)
    print(f"wrote Spotify playlist: {playlist_id}")
    return 0


def cmd_run(args: argparse.Namespace, store: Store) -> int:
    cmd_ingest(args, store)
    selected, rejected, candidates = generate_playlist(store, Path(args.config_dir), args.mode, args.length)
    write_outputs(store, selected, rejected, candidates)
    print(markdown_table(selected))
    if args.yes:
        playlist_id = write_spotify_playlist(selected, args.playlist_name, args.public, True)
        store.record_run(args.playlist_name, args.mode, True, playlist_id, [item.id for item in selected])
        print(f"wrote Spotify playlist: {playlist_id}")
    else:
        print("dry run only. Use write-spotify --playlist-name NAME or run --yes to write.")
    return 0


def generate_playlist(store: Store, config_dir: Path, mode: str, length: int | None) -> tuple[list[Candidate], list[Candidate], list[Candidate]]:
    candidates, rejected = build_candidates(store, config_dir, None)
    rules = load_yaml(config_dir / "rules.yaml")
    selected = sequence_playlist(candidates, rules, length, mode)
    mode_config = rules.get("modes", {}).get(mode, {})
    purpose = mode_config.get("purpose", "a balanced playlist")
    for candidate in selected:
        candidate.why = candidate.why.replace("Selected because", f"Selected for {mode} ({purpose}) because", 1)
    return selected, rejected, candidates


def build_candidates(store: Store, config_dir: Path, limit: int | None) -> tuple[list[Candidate], list[Candidate]]:
    review_policy = load_yaml(config_dir / "review_policy.yaml")
    candidates = dedupe_candidates(store.candidates())
    kept, rejected = apply_vetoes(candidates, review_policy)
    scored = score_candidates(kept)
    if limit:
        scored = scored[:limit]
    return scored, rejected


def load_sources(path: Path) -> list[SourceConfig]:
    raw = load_yaml(path)
    return [SourceConfig.from_dict(item) for item in raw]


def write_outputs(store: Store, selected: list[Candidate], rejected: list[Candidate], candidates: list[Candidate], bridge: bool = False) -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    resolved, unresolved = resolve_shortlist(selected)
    (OUTPUT_DIR / "candidates.json").write_text(
        json.dumps([candidate_to_json(item) for item in candidates], indent=2),
        encoding="utf-8",
    )
    (OUTPUT_DIR / "discovered_candidates.json").write_text(
        json.dumps([candidate_to_json(item) for item in candidates], indent=2),
        encoding="utf-8",
    )
    FINAL_JSON.write_text(json.dumps([candidate_to_json(item) for item in selected], indent=2), encoding="utf-8")
    (OUTPUT_DIR / "final_playlist.md").write_text(markdown_table(selected), encoding="utf-8")
    (OUTPUT_DIR / "shortlist.md").write_text(markdown_table(selected), encoding="utf-8")
    (OUTPUT_DIR / "final_spotify_playlist.md").write_text(markdown_table(resolved), encoding="utf-8")
    (OUTPUT_DIR / "unresolved_interesting.md").write_text(markdown_table(unresolved), encoding="utf-8")
    (OUTPUT_DIR / "rejected.md").write_text(rejected_markdown(rejected), encoding="utf-8")
    (OUTPUT_DIR / "source_report.md").write_text(source_report_markdown(store, resolved), encoding="utf-8")
    if bridge:
        (OUTPUT_DIR / "bridge_playlist.md").write_text(markdown_table(selected), encoding="utf-8")
        (OUTPUT_DIR / "bridge_candidates.json").write_text(
            json.dumps([candidate_to_json(item) for item in candidates if item.bridge_source_score], indent=2),
            encoding="utf-8",
        )


def resolve_shortlist(selected: list[Candidate]) -> tuple[list[Candidate], list[Candidate]]:
    resolver = SpotifyResolver()
    resolved = []
    spotify_available = True
    for item in selected:
        if spotify_available:
            try:
                resolver.resolve(item)
            except ApiError as exc:
                spotify_available = exc.status != 429
            except (OSError, SourceUnavailable):
                spotify_available = False
        resolved.append(item)
    playable = [item for item in resolved if item.spotify_uri]
    unresolved = [item for item in resolved if not item.spotify_uri]
    return playable, unresolved


def write_bridge_outputs(candidates: list[Candidate], rejected: list[Candidate]) -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    bridge_candidates = [item for item in candidates if item.bridge_source_score]
    (OUTPUT_DIR / "bridge_candidates.json").write_text(
        json.dumps([candidate_to_json(item) for item in bridge_candidates], indent=2),
        encoding="utf-8",
    )
    if bridge_candidates:
        (OUTPUT_DIR / "bridge_playlist.md").write_text(markdown_table(bridge_candidates[:40]), encoding="utf-8")
    (OUTPUT_DIR / "rejected.md").write_text(rejected_markdown(rejected), encoding="utf-8")


def source_report_markdown(store: Store, resolved: list[Candidate]) -> str:
    final_sources: dict[str, int] = {}
    for candidate in resolved:
        for source in candidate.sources:
            final_sources[source] = final_sources.get(source, 0) + 1

    lines = [
        "| Source | Platform | Type | Category | Discovered | Normalized | Spotify Resolved | Final Tracks | Notes |",
        "| ------ | -------- | ---- | -------- | ---------- | ---------- | ---------------- | ------------ | ----- |",
    ]
    for row in store.source_report():
        raw_count = int(row["raw_count"] or 0)
        normalized_count = int(row["normalized_count"] or 0)
        final_count = final_sources.get(row["name"], 0)
        notes = []
        if raw_count and normalized_count / raw_count < 0.3:
            notes.append("noisy or low-yield")
        if final_count:
            notes.append("produced final tracks")
        if float(row["best_bridge_score"] or 0) >= 80:
            notes.append("high bridge value")
        lines.append(
            f"| {row['name']} | {row['platform']} | {row['source_type']} | {row['category']} | "
            f"{raw_count} | {normalized_count} | {int(row['spotify_resolved_count'] or 0)} | {final_count} | {', '.join(notes)} |"
        )
    return "\n".join(lines) + "\n"


def write_spotify_playlist(selected: list[Candidate], playlist_name: str, public: bool, yes: bool) -> str:
    if not yes:
        answer = input(f"Write {len(selected)} tracks to Spotify playlist '{playlist_name}'? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            raise SystemExit("cancelled")

    client = SpotifyClient()
    resolver = SpotifyResolver(client)
    resolved: list[Candidate] = []
    for item in selected:
        try:
            resolver.resolve(item)
        except ApiError as exc:
            if exc.status == 429:
                break
            raise
        if item.spotify_uri:
            resolved.append(item)
    uris = list(dict.fromkeys(item.spotify_uri for item in resolved if item.spotify_uri))
    if not uris:
        raise SourceUnavailable("No strictly matched Spotify tracks are available; no playlist was created.")

    playlist = client.post(
        "/me/playlists",
        {"name": playlist_name, "description": "Distilled by qrator from trusted human sources.", "public": public},
    )
    for index in range(0, len(uris), 100):
        client.post(f"/playlists/{playlist['id']}/items", {"uris": uris[index : index + 100]})
    return playlist["id"]


def resolve_spotify_uri(client: SpotifyClient, candidate: Candidate) -> str | None:
    if candidate.spotify_uri:
        return candidate.spotify_uri
    query = f'artist:"{candidate.artist}" track:"{candidate.title}"'
    result = client.get("/search", params={"type": "track", "limit": 1, "q": query})
    items = result.get("tracks", {}).get("items", [])
    return items[0].get("uri") if items else None


def find_track(pool: list[Candidate], parsed: tuple[str, str] | None, raw: str) -> Candidate | None:
    needle = raw.lower()
    for item in pool:
        if parsed and item.artist.lower() == parsed[0].lower() and item.title.lower() == parsed[1].lower():
            return item
        if needle in f"{item.artist} - {item.title}".lower():
            return item
    return None


def candidate_to_json(item: Candidate) -> dict:
    return {
        "id": item.id,
        "artist": item.artist,
        "title": item.title,
        "album": item.album,
        "spotify_uri": item.spotify_uri,
        "soundcloud_url": item.soundcloud_url,
        "musicbrainz_id": item.musicbrainz_id,
        "score": item.score,
        "shelf_confidence": item.shelf_confidence,
        "recording_confidence": item.recording_confidence,
        "discovery_distance": item.discovery_distance,
        "sources": item.sources,
        "platforms": item.platforms,
        "playlist_titles": item.playlist_titles,
        "why": item.why,
        "pools": item.pools,
        "score_components": item.score_components,
        "bridge_source_score": item.bridge_source_score,
        "bridge_match_types": item.bridge_match_types,
        "bridge_seed_sides": item.bridge_seed_sides,
    }


def candidate_from_json(item: dict) -> Candidate:
    return Candidate(**item)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable

from music_harvester.engine.normalize import normalize_key, normalize_text
from music_harvester.models import Candidate, MusicCandidate, RawTrack, SourceConfig


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row

    def init(self) -> None:
        schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
        self.conn.executescript(schema)
        self._ensure_columns()
        self.conn.commit()

    def _ensure_columns(self) -> None:
        migrations = {
            "sources": {
                "category": "text not null default 'structured_api'",
            },
            "raw_tracks": {
                "source_platform": "text",
                "source_type": "text",
                "source_name": "text",
                "source_url": "text",
                "source_weight": "real",
                "source_context": "text",
                "extraction_confidence": "real not null default 1.0",
                "normalization_confidence": "real not null default 1.0",
                "spotify_resolution_confidence": "real not null default 0.0",
            },
            "bridge_sources": {
                "seed_sides_json": "text not null default '[]'",
            },
        }
        for table, columns in migrations.items():
            existing = {row["name"] for row in self.conn.execute(f"pragma table_info({table})").fetchall()}
            for name, ddl in columns.items():
                if name not in existing:
                    self.conn.execute(f"alter table {table} add column {name} {ddl}")

    def upsert_source(self, source: SourceConfig) -> int:
        self.conn.execute(
            """
            insert into sources (name, platform, source_type, url_or_username, weight, category)
            values (?, ?, ?, ?, ?, ?)
            on conflict(name) do update set
              platform=excluded.platform,
              source_type=excluded.source_type,
              url_or_username=excluded.url_or_username,
              weight=excluded.weight,
              category=excluded.category
            """,
            (source.name, source.platform, source.source_type, source.locator, source.weight, source.category),
        )
        self.conn.commit()
        return int(self.conn.execute("select id from sources where name = ?", (source.name,)).fetchone()["id"])

    def add_error(self, source_name: str, message: str, source_id: int | None = None) -> None:
        self.conn.execute(
            "insert into source_errors (source_id, source_name, message) values (?, ?, ?)",
            (source_id, source_name, message),
        )
        self.conn.commit()

    def add_raw_tracks(self, source_id: int, tracks: Iterable[RawTrack]) -> int:
        source = self.source_by_id(source_id)
        return self.add_music_candidates(
            source_id,
            [track.to_music_candidate(source) if isinstance(track, RawTrack) else track for track in tracks],
        )

    def add_music_candidates(self, source_id: int, candidates: Iterable[MusicCandidate]) -> int:
        count = 0
        for candidate in candidates:
            raw_id = self._insert_music_candidate(source_id, candidate)
            normalized_id = self._upsert_normalized(candidate)
            self._insert_provenance(normalized_id, source_id, candidate)
            count += 1 if raw_id else 0
        self.conn.commit()
        return count

    def source_by_id(self, source_id: int) -> SourceConfig:
        row = self.conn.execute("select * from sources where id = ?", (source_id,)).fetchone()
        return SourceConfig(
            name=row["name"],
            platform=row["platform"],
            source_type=row["source_type"],
            url=row["url_or_username"],
            weight=float(row["weight"]),
            category=row["category"],
        )

    def _insert_music_candidate(self, source_id: int, track: MusicCandidate) -> int:
        cursor = self.conn.execute(
            """
            insert into raw_tracks (
              source_id, platform_track_id, raw_artist, raw_title, raw_album, raw_url,
              source_platform, source_type, source_name, source_url, source_weight, source_context,
              extraction_confidence, normalization_confidence, spotify_resolution_confidence,
              raw_payload_json
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_id,
                track.platform_track_id,
                track.artist,
                track.title,
                track.album,
                track.url,
                track.source_platform,
                track.source_type,
                track.source_name,
                track.source_url,
                track.source_weight,
                track.source_context,
                track.extraction_confidence,
                track.normalization_confidence,
                track.spotify_resolution_confidence,
                json.dumps(track.payload),
            ),
        )
        return int(cursor.lastrowid)

    def _upsert_normalized(self, track: MusicCandidate) -> int:
        artist = normalize_text(track.artist)
        title = normalize_text(track.title)
        album = normalize_text(track.album) if track.album else None
        key = normalize_key(artist, title)
        spotify_uri = track.payload.get("spotify_uri") if track.platform == "spotify" else None
        soundcloud_url = track.url if track.platform == "soundcloud" else None

        self.conn.execute(
            """
            insert into normalized_tracks (
              canonical_artist, canonical_title, canonical_album, spotify_uri, soundcloud_url, unique_key
            ) values (?, ?, ?, ?, ?, ?)
            on conflict(unique_key) do update set
              spotify_uri=coalesce(normalized_tracks.spotify_uri, excluded.spotify_uri),
              soundcloud_url=coalesce(normalized_tracks.soundcloud_url, excluded.soundcloud_url),
              canonical_album=coalesce(normalized_tracks.canonical_album, excluded.canonical_album)
            """,
            (artist, title, album, spotify_uri, soundcloud_url, key),
        )
        row = self.conn.execute("select id from normalized_tracks where unique_key = ?", (key,)).fetchone()
        return int(row["id"])

    def _insert_provenance(self, normalized_id: int, source_id: int, track: MusicCandidate) -> None:
        self.conn.execute(
            """
            insert into track_provenance (
              normalized_track_id, source_id, source_context, playlist_title, position
            ) values (?, ?, ?, ?, ?)
            """,
            (normalized_id, source_id, track.source_context, track.playlist_title, track.position),
        )

    def candidates(self) -> list[Candidate]:
        rows = self.conn.execute(
            """
            select
              nt.id,
              nt.canonical_artist,
              nt.canonical_title,
              nt.canonical_album,
              nt.spotify_uri,
              nt.soundcloud_url,
              group_concat(distinct s.name) as source_names,
              group_concat(distinct s.platform) as platforms,
              group_concat(distinct coalesce(tp.playlist_title, '')) as playlist_titles,
              avg(rt.extraction_confidence) as extraction_confidence,
              avg(rt.normalization_confidence) as normalization_confidence,
              max(rt.spotify_resolution_confidence) as spotify_resolution_confidence,
              coalesce(max(bs.confidence_score), 0) as bridge_source_score,
              group_concat(distinct bs.match_type) as bridge_match_types,
              group_concat(distinct bs.seed_sides_json) as bridge_seed_sides_json,
              max(case when bs.match_type in ('exact_all_seeds', 'exact_some_seeds', 'near_bridge') then 1 else 0 end) as has_strong_bridge_match,
              sum(s.weight) as source_weight,
              count(distinct s.id) as source_count,
              count(distinct s.platform) as platform_count
            from normalized_tracks nt
            join track_provenance tp on tp.normalized_track_id = nt.id
            join sources s on s.id = tp.source_id
            left join raw_tracks rt on rt.source_id = s.id
              and lower(rt.raw_artist) = lower(nt.canonical_artist)
              and lower(rt.raw_title) = lower(nt.canonical_title)
            left join bridge_sources bs on bs.source_id = s.id
            group by nt.id
            """
        ).fetchall()

        return [
            Candidate(
                id=int(row["id"]),
                artist=row["canonical_artist"],
                title=row["canonical_title"],
                album=row["canonical_album"],
                spotify_uri=row["spotify_uri"],
                soundcloud_url=row["soundcloud_url"],
                score=float(row["source_weight"] or 0),
                sources=_csv(row["source_names"]),
                platforms=_csv(row["platforms"]),
                playlist_titles=[item for item in _csv(row["playlist_titles"]) if item],
                why="",
                bridge_source_score=float(row["bridge_source_score"] or 0),
                bridge_match_types=_csv(row["bridge_match_types"]),
                bridge_seed_sides=_json_list_csv(row["bridge_seed_sides_json"]) if int(row["has_strong_bridge_match"] or 0) else [],
                extraction_confidence=float(row["extraction_confidence"] or 1.0),
                normalization_confidence=float(row["normalization_confidence"] or 1.0),
                spotify_resolution_confidence=float(row["spotify_resolution_confidence"] or 0.0),
            )
            for row in rows
        ]

    def source_report(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            select
              s.name,
              s.platform,
              s.source_type,
              s.category,
              count(distinct rt.id) as raw_count,
              count(distinct nt.id) as normalized_count,
              count(distinct case when nt.spotify_uri is not null then nt.id end) as spotify_resolved_count,
              coalesce(max(bs.confidence_score), 0) as best_bridge_score
            from sources s
            left join raw_tracks rt on rt.source_id = s.id
            left join track_provenance tp on tp.source_id = s.id
            left join normalized_tracks nt on nt.id = tp.normalized_track_id
            left join bridge_sources bs on bs.source_id = s.id
            group by s.id
            order by normalized_count desc, best_bridge_score desc
            """
        ).fetchall()

    def create_bridge_run(self, seed_type: str, seed_values: list[str]) -> int:
        cursor = self.conn.execute(
            "insert into bridge_runs (seed_type, seed_values_json) values (?, ?)",
            (seed_type, json.dumps(seed_values)),
        )
        self.conn.commit()
        return int(cursor.lastrowid)

    def add_bridge_source(
        self,
        bridge_run_id: int,
        source_id: int | None,
        match_type: str,
        confidence_score: float,
        matched_seeds: list[str],
        seed_sides: list[str] | None = None,
        notes: str | None = None,
    ) -> None:
        self.conn.execute(
            """
            insert into bridge_sources (
              bridge_run_id, source_id, match_type, confidence_score, matched_seeds_json, seed_sides_json, notes
            ) values (?, ?, ?, ?, ?, ?, ?)
            """,
            (bridge_run_id, source_id, match_type, confidence_score, json.dumps(matched_seeds), json.dumps(seed_sides or []), notes),
        )
        self.conn.commit()

    def bridge_sources_for_run(self, bridge_run_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            select
              bs.*,
              s.name,
              s.platform,
              s.source_type,
              s.url_or_username
            from bridge_sources bs
            left join sources s on s.id = bs.source_id
            where bs.bridge_run_id = ?
            order by bs.confidence_score desc
            """,
            (bridge_run_id,),
        ).fetchall()

    def latest_bridge_run_id(self) -> int | None:
        row = self.conn.execute("select id from bridge_runs order by id desc limit 1").fetchone()
        return int(row["id"]) if row else None

    def add_feedback(self, artist: str, title: str, rating: str, note: str | None = None) -> bool:
        key = normalize_key(artist, title)
        row = self.conn.execute("select id from normalized_tracks where unique_key = ?", (key,)).fetchone()
        if not row:
            return False
        self.conn.execute(
            "insert into feedback (normalized_track_id, rating, note) values (?, ?, ?)",
            (int(row["id"]), rating, note),
        )
        self.conn.commit()
        return True

    def feedback_map(self) -> dict[int, list[str]]:
        rows = self.conn.execute("select normalized_track_id, rating from feedback").fetchall()
        result: dict[int, list[str]] = {}
        for row in rows:
            result.setdefault(int(row["normalized_track_id"]), []).append(row["rating"])
        return result

    def recently_played_ids(self, days: int) -> set[int]:
        rows = self.conn.execute(
            "select normalized_track_id from plays where played_at >= datetime('now', ?)",
            (f"-{days} days",),
        ).fetchall()
        return {int(row["normalized_track_id"]) for row in rows}

    def record_run(self, name: str, mode: str, written: bool, spotify_playlist_id: str | None, track_ids: list[int]) -> int:
        cursor = self.conn.execute(
            "insert into playlist_runs (name, mode, written_to_spotify, spotify_playlist_id) values (?, ?, ?, ?)",
            (name, mode, 1 if written else 0, spotify_playlist_id),
        )
        run_id = int(cursor.lastrowid)
        for track_id in track_ids:
            self.conn.execute(
                "insert into plays (normalized_track_id, playlist_run_id) values (?, ?)",
                (track_id, run_id),
            )
        self.conn.commit()
        return run_id


def _csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [part for part in value.split(",") if part]


def _json_list_csv(value: str | None) -> list[str]:
    result: list[str] = []
    for part in _csv(value):
        try:
            loaded = json.loads(part)
        except json.JSONDecodeError:
            loaded = []
        for item in loaded:
            if item not in result:
                result.append(item)
    return result

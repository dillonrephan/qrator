from __future__ import annotations

from urllib.parse import quote_plus

from music_harvester.models import Candidate


def markdown_table(candidates: list[Candidate]) -> str:
    lines = [
        "| # | Artist | Track | Listen / catalog | Score | Pool(s) | Source(s) | Why |",
        "| - | ------ | ----- | ---------------- | ----- | ------- | --------- | --- |",
    ]
    for index, item in enumerate(candidates, 1):
        lines.append(
            "| {idx} | {artist} | {title} | {links} | {score:.2f} | {pools} | {sources} | {why} |".format(
                idx=index,
                artist=escape_md(item.artist),
                title=escape_md(item.title),
                links=platform_links(item),
                score=item.score,
                pools=escape_md(", ".join(item.pools)),
                sources=escape_md(", ".join(item.sources)),
                why=escape_md(item.why),
            )
        )
    return "\n".join(lines) + "\n"


def platform_links(item: Candidate) -> str:
    links = []
    if item.spotify_uri:
        track_id = item.spotify_uri.rsplit(":", 1)[-1]
        links.append(f"[Spotify](https://open.spotify.com/track/{track_id})")
    if item.soundcloud_url:
        links.append(f"[SoundCloud]({item.soundcloud_url})")
    if item.musicbrainz_id:
        links.append(f"[MusicBrainz](https://musicbrainz.org/recording/{item.musicbrainz_id})")
    query = quote_plus(f"{item.artist} {item.title}")
    links.append(f"[YouTube search](https://www.youtube.com/results?search_query={query})")
    links.append(f"[SoundCloud search](https://soundcloud.com/search/sounds?q={query})")
    return " / ".join(links) or "unresolved"


def rejected_markdown(candidates: list[Candidate]) -> str:
    lines = ["# Rejected Tracks", ""]
    if not candidates:
        lines.append("No rejected tracks.")
    for item in candidates:
        lines.append(f"- **{escape_md(item.artist)} - {escape_md(item.title)}**: {escape_md(item.rejection_reason or 'rejected')}")
    return "\n".join(lines) + "\n"


def escape_md(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")

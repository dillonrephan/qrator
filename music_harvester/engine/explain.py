from __future__ import annotations

from music_harvester.models import Candidate


def markdown_table(candidates: list[Candidate]) -> str:
    lines = [
        "| # | Artist | Track | Score | Pool(s) | Source(s) | Why |",
        "| - | ------ | ----- | ----- | ------- | --------- | --- |",
    ]
    for index, item in enumerate(candidates, 1):
        lines.append(
            "| {idx} | {artist} | {title} | {score:.2f} | {pools} | {sources} | {why} |".format(
                idx=index,
                artist=escape_md(item.artist),
                title=escape_md(item.title),
                score=item.score,
                pools=escape_md(", ".join(item.pools)),
                sources=escape_md(", ".join(item.sources)),
                why=escape_md(item.why),
            )
        )
    return "\n".join(lines) + "\n"


def rejected_markdown(candidates: list[Candidate]) -> str:
    lines = ["# Rejected Tracks", ""]
    if not candidates:
        lines.append("No rejected tracks.")
    for item in candidates:
        lines.append(f"- **{escape_md(item.artist)} - {escape_md(item.title)}**: {escape_md(item.rejection_reason or 'rejected')}")
    return "\n".join(lines) + "\n"


def escape_md(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")

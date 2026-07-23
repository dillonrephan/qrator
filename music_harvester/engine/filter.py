from __future__ import annotations

from music_harvester.models import Candidate


def apply_vetoes(candidates: list[Candidate], taste_profile: dict) -> tuple[list[Candidate], list[Candidate]]:
    veto = taste_profile.get("veto", {})
    artists = {item.lower() for item in veto.get("artists", [])}
    title_words = [item.lower() for item in veto.get("title_words", [])]

    kept: list[Candidate] = []
    rejected: list[Candidate] = []
    for candidate in candidates:
        artist = candidate.artist.lower()
        title = candidate.title.lower()
        reason = None
        if artist in artists:
            reason = "vetoed artist"
        else:
            for word in title_words:
                if word in title:
                    reason = f"vetoed title word: {word}"
                    break

        if reason:
            candidate.rejected = True
            candidate.rejection_reason = reason
            rejected.append(candidate)
        else:
            kept.append(candidate)

    return kept, rejected

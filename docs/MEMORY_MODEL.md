# QRator Memory Model

Last updated: 2026-08-04

## Default: a local, user-taught taste profile

Discovery workspaces and run databases remain temporary, but QRator now learns
from explicit review. **More like this** and **Less like this** judgments persist
locally and shape the ordering of later discovery runs.

The product question is now:

> What has the user deliberately taught QRator about their taste, and how did
> that evidence affect this result?

QRator does not silently equate provider popularity, listen counts, shelf
confidence, or metadata quality with taste.

SoundCloud discovery shelves are concrete public user likes lists and
playlists. Algorithmic radio/similarity responses are not represented as human
curation and do not contribute shelf evidence. A shelf requires at least two
distinct shortlist hits. Stronger explanations preserve whether those hits
came from one likes list, one hand-made playlist, or several playlists owned by
the same profile.

## Durable taste boundary

Each judgment stores the candidate's stable identity, artist, title, album,
known platform identifiers, sources, preference, and creation/update times in
`data/taste-profile.json`. The file is ignored by Git, written atomically, and
owner-readable/writable only.

The profile view exposes:

- every track judgment;
- aggregate positive and negative artist/source signals;
- per-entry removal;
- complete JSON export;
- complete profile erasure.

Future discovery preserves the original shelf-confidence value and adds a
separate, bounded taste adjustment. Exact track judgments have the strongest
effect. Repeated artist and source judgments add smaller aggregate effects.
Candidates expose both the adjustment and plain-language reasons; profile
influence never masquerades as source or recording confidence.

## Review behavior

- **More like this** is a durable positive taste judgment and prioritizes the
  track as a seed for the next expansion.
- **Less like this** is a durable negative taste judgment, lowers the track in
  future discovery, and excludes it from the current publish/expansion set.
- Pressing an active judgment again removes it from the durable profile.
- A new run restores judgments for tracks QRator has already seen.
- Playback, pause, and listening duration are not taste judgments. The profile
  changes only through the explicit more/less controls.

Neutral candidates remain publishable. Marking **More like this** advances to
the next queued track. At the end of the queue—even when the supplied shelf had
only one track—the liked track or tracks become seeds for a new expansion, and
the first new result starts in the player automatically.

## Evidence vocabulary

QRator presents four independent descriptions:

- **Shelf confidence:** strength of the path from the supplied seed/source to
  the shelf where a recording was found.
- **Discovery distance:** whether the recording was directly supplied or found
  one bounded shelf hop away.
- **Recording confidence:** confidence that metadata identifies a coherent
  recording.
- **Taste influence:** bounded ordering adjustment derived only from explicit
  local judgments.

The profile is intentionally explicit and editable. Passive listening-history
imports, genre/feature inference, recency decay, and implicit behavior tracking
remain future decisions rather than hidden inputs. Provider top/recent tracks
may be used as ephemeral discovery seeds only when the user explicitly requests
that run; they are not written into the durable taste profile.

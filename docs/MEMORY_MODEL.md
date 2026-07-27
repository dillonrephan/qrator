# QRator Memory Model

Last updated: 2026-07-27

## Default: a fresh room

Discovery runs are temporary. Seeds, source adjustments, shortlist membership,
and run databases are removed after the request. QRator does not ship with a
taste profile, infer a durable one, or use saved metadata to rank later runs.

The default product question is:

> Which shelves are credibly connected to the sources the user chose?

It is not:

> What kind of person does an algorithm think the user is?

## Explicit durable boundary

The GUI action **Save this track's metadata forever** is the only current path
from a discovery candidate into the durable local metadata archive.

The server validates the candidate against the active, short-lived run. It does
not accept arbitrary client-supplied artist/title metadata. The archive stores:

- canonical artist, title, and album text;
- known Spotify, SoundCloud, and MusicBrainz identifiers;
- the source names that exposed the recording;
- the explicit save timestamp.

It deliberately excludes shelf confidence, recording confidence, discovery
distance, the internal selection score, score components, and the generated
recommendation explanation. The archive is stored at
`data/saved-tracks.json`, ignored by Git, and written with owner-only
permissions.

Saved metadata is visible in its own GUI view, exportable as JSON, and removable
one item at a time. Removal requires an explicit confirmation.

## Evidence, not taste

QRator presents three independent descriptions:

- **Shelf confidence:** strength of the evidence path from the supplied source
  or seed to the shelf where the recording was found.
- **Discovery distance:** whether the recording was directly supplied or found
  one bounded shelf hop away.
- **Recording confidence:** confidence that the metadata identifies a coherent
  recording, independent of whether it is available on a publishing target.

None is a prediction that the user will enjoy the recording.

## Current session controls

The review list now has two deliberately temporary judgments:

- **Keep for this mix** marks a strong candidate. When at least two candidates
  are kept, the next **Expand from shortlist** action uses those tracks as its
  seeds. It does not exclude neutral candidates from the current mix.
- **Skip this one** removes a candidate from the next expansion and from an
  explicitly published Spotify playlist.

Neutral candidates remain in the mix. Both judgments exist only in browser
memory, reset when a new run succeeds or the page reloads, and are never sent
to the metadata archive. On publish, the server validates the reviewed
current-mix candidate identifiers against the short-lived discovery run; client-supplied
tracks cannot be injected.

“Raid this shelf deeper” remains future work because it needs a first-class
source/shelf identifier rather than pretending that a track seed and a shelf
are equivalent.

Any future persistent judgment store must be inspectable, exportable, erasable,
disabled by default, and separate from the explicit metadata archive.

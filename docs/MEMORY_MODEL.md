# QRator Memory Model

Last updated: 2026-07-26

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

## Future session controls

Session-only actions such as “keep for this mix,” “skip this one,” and “raid
this shelf deeper” may reshape the active run. They must not cross into durable
storage unless a separate, plainly labeled local-memory feature is enabled.
Any future persistent judgment store must be inspectable, exportable, erasable,
disabled by default, and separate from the explicit metadata archive.

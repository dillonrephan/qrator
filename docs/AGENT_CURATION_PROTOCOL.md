# Agent Curation Protocol

Status: connected SoundCloud agent workflow implemented; publication tested with fixtures, not a live playlist write.

## Agent operation

Use `node bin/qrator-curate.mjs COMMAND` with JSON on stdin. No running web
server or GUI is required. The workflow reuses the existing official harvester.

1. `harvest`: supply `brief`, `seed_type` (`tracks` or `artists`), 2–20 distinct
   `seeds`, optional `reference_tracks`, and optional `budget` with `requests`
   (1–100, default 40) and `seconds` (1–180, default 60). The existing overlap
   threshold is exactly two; other requested thresholds are rejected.
2. Retain the returned `run_id`. Inspect `snapshot.candidates` and the partial
   harvest receipt. Zero qualifying shelves is an error, never discovery success.
3. `validate`: supply `run_id` and ordered `items`, each with `recording_key`,
   `rationale`, and `traits`. Identity and shelf evidence come from the saved
   harvest, not caller-supplied candidates or labels. Brief constraints remain
   bound to that harvest. Rejections must be addressed before publishing.
4. `publish`: submit the same selection plus
   `publish: {confirmed: true, provider: "soundcloud", name: "Chosen name",
   visibility: "private"}` (or explicitly `public`). This requires actual user
   authorization; the JSON flag is not authentication. Every recording must
   resolve, including matching known SoundCloud URNs. No automatic partial mix.

Example harvest input:

```json
{"brief":{"objective":"Driven music with breathing room, not airy.","requested_length":20},"seed_type":"tracks","seeds":["Artist - First reference","Artist - Second reference"],"budget":{"requests":40,"seconds":60}}
```

Run evidence and publication receipts are private operational files under
`~/.local/state/qrator/agent-runs`, outside project source. They persist for
resumption; no automatic deletion is claimed. Ephemeral recipe intent means
no taste-profile or saved-recipe update, not absence of operational evidence.
One publication attempt per harvest is recorded before provider writes.
Identical completed requests return the saved receipt; uncertain or changed
requests require reconciliation and never automatically resend.

`brief` remains an offline normalization command. `snapshot` remains an offline
document converter, not proof of a harvest and not publish authority. The
low-level proposal validator remains available as a library for synthetic
checks; the agent CLI requires a saved harvest.

Qualification limits: fixtures cover bound selection, order, budget, empty
harvest, explicit publishing and uncertain retry. Provider search and the
underlying harvester were exercised live before this wiring change. The new
complete CLI has not yet had a live harvest-to-publication qualification.
No playlist was published during implementation. Spotify publishing remains
available through the existing app, not this new agent command.

QRator is an AI-native crate-digging workbench. It does not ask a human to
simulate a recommendation model with dozens of sliders, and it does not ask a
language model to bypass provider, identity, provenance, or publishing
boundaries.

The human describes what the music is for and judges the result. The agent
translates that brief into a temporary working recipe, explores bounded human
shelves, rejects irrelevant neighborhoods, proposes exact recordings, and
explains the sequence. QRator supplies the evidence graph and enforces the
mechanical contract.

## Responsibilities

### Human

- describes function, references, counterexamples, and desired change;
- listens and gives plain-language corrections;
- explicitly chooses whether a recipe becomes durable; and
- explicitly authorizes publishing and visibility.

### Curation agent

- preserves the human's objective verbatim in the brief;
- converts subjective language into temporary, inspectable traits and limits;
- requests bounded provider and shelf exploration from QRator;
- rejects whole irrelevant neighborhoods rather than laundering every result
  into a score;
- proposes exact recordings in a deliberate order; and
- supplies a concise rationale and concrete shelf/curator evidence for every
  included track.

### QRator

- authenticates to providers without exposing credentials;
- traverses documented, bounded human-curation surfaces;
- normalizes identities and provenance;
- excludes reference recordings and duplicate candidates;
- enforces artist-density, consecutive-artist, length, and explicit negative
  trait boundaries;
- emits an inspectable validation receipt; and
- keeps publishing separate from curation validation.

## Brief contract

Version 1 preserves a natural-language `objective`, a requested length,
desired and avoided traits, reference-exclusion policy, artist-density limits,
and memory intent.

Memory defaults to `ephemeral`. The only durable mode is `explicit-save`, and
it requires a human-readable recipe label. A validated curation never implies
permission to publish: the normalized brief always returns a non-publishing
state. Provider publication remains a distinct, explicit operation after
review.

```json
{
  "version": 1,
  "objective": "Dense, driven motion with melody as a handrail; never airy.",
  "requested_length": 60,
  "desired_traits": ["driven", "dense", "melodic"],
  "avoid_traits": ["airy", "slowed edit"],
  "constraints": {
    "exclude_reference_recordings": true,
    "max_tracks_per_artist": 6,
    "max_consecutive_by_artist": 1,
    "minimum_shelf_overlap": 2
  },
  "memory": { "mode": "ephemeral" }
}
```

## Proposal contract

The agent submits an ordered list. Each item carries a canonical candidate,
temporary traits, a curator rationale, and one or more evidence labels. QRator
does not reorder an accepted proposal behind the agent's back. It walks the
proposed order and fails individual candidates closed when they violate the
brief.

Current hard rejection reasons are:

- missing recording identity;
- missing curator rationale;
- missing shelf or curator evidence;
- duplicate recording;
- present in excluded reference material;
- an explicitly avoided trait;
- artist-density or consecutive-artist cap; and
- requested length already reached.

The receipt reports accepted/rejected counts, reference exclusions, unique
recordings, memory intent, and the fact that no publishing action was inferred.
It deliberately contains no token, cookie, provider secret, listening history,
or hidden taste inference.

## Offline document utilities

The brief and snapshot utilities perform no network,
database, memory, or publishing operation and accepts at most 2 MiB of JSON:

```bash
npm run curate:brief < brief.json
npm run curate:snapshot < discovery-response.json
```

Structural errors fail with exit status 2 and one JSON error on stderr. Track
rejections are successful validation output rather than process failures, so
an agent can inspect and revise them without parsing logs.

The snapshot command consumes the JSON returned by a discovery run and emits a
deterministic, content-addressed candidate document. It retains only a strict
allowlist of public recording metadata, confidence, shelf labels, and curation
evidence. Runtime IDs, process logs, taste judgments, tokens, cookies, and
credentials are not part of the snapshot schema. Repeating the command on the
same input produces the same `snapshot_id`; duplicate recording identities are
merged without changing first-seen order.

Remaining work (not claimed implemented):

1. Convert reference playlists into exact recording-exclusion sets.
2. Let agents attach temporary energy, pressure, airiness, and reset-point
   annotations without treating those annotations as permanent user taste.
3. Qualify the connected publish command with a deliberately authorized live
   playlist and independently read back its saved recording order.
4. Present the same evidence and rejection reasons in the GUI as supervision,
   not as a wall of manual tuning controls.

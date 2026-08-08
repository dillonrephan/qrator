# Agent Curation Protocol

Status: first contract and resumable provider snapshots available

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

## Next integration

The first owner-local interface is available now. It performs no network,
database, memory, or publishing operation and accepts at most 2 MiB of JSON:

```bash
npm run curate:brief < brief.json
npm run curate:snapshot < discovery-response.json
npm run curate:validate < proposal.json
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

Next:

1. Convert reference playlists into exact recording-exclusion sets.
2. Let agents attach temporary energy, pressure, airiness, and reset-point
   annotations without treating those annotations as permanent user taste.
3. Add a separate reviewed publish command that consumes a successful receipt,
   resolves every exact target recording, and returns a provider receipt.
4. Present the same evidence and rejection reasons in the GUI as supervision,
   not as a wall of manual tuning controls.

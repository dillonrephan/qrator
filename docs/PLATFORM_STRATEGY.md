# QRator Platform Strategy

Status: foundation plan, not yet implemented

Last reviewed: 2026-07-23

## Objective

QRator will use SoundCloud as its primary discovery surface, Last.fm as a
listening-history and similarity signal, and Spotify as a catalog resolver and
publishing destination within the access granted to the configured Spotify
application.

The internal catalog must remain platform-neutral. A candidate is a musical
work or recording supported by provenance; it is not a Spotify URI or a
SoundCloud URL with scoring fields attached. Platform identifiers and
availability are target-specific resolutions of that candidate.

This plan deliberately excludes two brittle techniques from the production
architecture:

- extracting a SoundCloud client ID from SoundCloud's web application bundles;
- scraping Spotify playlist HTML to recover track identifiers.

Both can fail without notice and bypass the supported API capability model.

## Official SoundCloud Integration

All SoundCloud traffic will use the documented `api.soundcloud.com` and
`secure.soundcloud.com` endpoints with a registered SoundCloud application.
Current SoundCloud registration requires an Artist Pro account.

QRator needs two distinct OAuth flows:

1. Client credentials for public discovery operations such as search and URL
   resolution. The access token and its refresh token must be cached and reused;
   QRator must not exchange credentials for every request or process.
2. Authorization Code with OAuth 2.1 PKCE for actions performed for a user,
   including creating a playlist. The callback must verify both PKCE and a
   short-lived, single-use `state` value. Access and rotating refresh tokens
   must be stored with owner-only permissions and never committed.

The initial SoundCloud adapter will support bounded public track, playlist, and
user discovery. It will hydrate playlist tracks through documented endpoints
rather than assuming an embedded `tracks` array is complete. Collection
pagination must enforce a page limit, item limit, deadline, and repeated-cursor
guard.

SoundCloud publishing is feasible through the official API:

- resolve eligible candidates to stable SoundCloud track IDs;
- preflight the complete private playlist payload;
- create it with `POST /playlists`;
- update it with `PUT /playlists/{id}` only through an explicit, recoverable
  publish operation.

Publishing is disabled until user OAuth, token rotation, strict SoundCloud
matching, and publish-state recovery are implemented and tested.

References:

- [SoundCloud API guide](https://developers.soundcloud.com/docs/api/)
- [SoundCloud application registration](https://developers.soundcloud.com/docs/api/register-app)
- [SoundCloud rate limits](https://developers.soundcloud.com/docs/api/rate-limits.html)

## Platform-Neutral Candidates and Target Eligibility

The canonical candidate record should contain normalized artist, title,
recording/version information, optional external identifiers, provenance, and
confidence. Platform resolution belongs in a separate structure keyed by
candidate and target:

| Target | Required eligibility evidence |
| --- | --- |
| Spotify | A strictly matched Spotify track URI with confidence above the configured threshold |
| SoundCloud | A playable SoundCloud track ID with confidence above the configured threshold |
| Review/export | Canonical metadata and at least one accepted provenance edge |

Scoring answers “is this recommendation interesting and well supported?”
Eligibility answers “can this exact recording be published to this target?”
The two decisions must not be conflated.

For a target playlist, QRator should rank a bounded oversample, resolve it for
that target, route unresolved candidates to a review report, and sequence only
eligible candidates. This prevents SoundCloud-only discoveries from consuming
slots in a Spotify playlist while preserving them for SoundCloud publishing or
manual review.

Resolvers must never silently accept the first search result. Matching should
compare normalized artist and title, version qualifiers such as live/remix/edit,
duration when available, and stable external identifiers. Confidence must
reflect both match quality and the margin over the next-best result.

## Bounded Trust Spider

The trust spider is a bounded evidence graph, not an unrestricted crawler.

- Source nodes represent explicit user inputs or discovered playlists,
  profiles, and collections.
- Candidate nodes represent canonical recordings.
- Provenance edges represent one observed occurrence in a specific source and
  ingest run.
- User-provided sources and seeds are roots. Discovered sources form a limited
  frontier.

Every provenance edge must be idempotent. SQL aggregation must first reduce to
one effective edge per candidate and source so raw rows, repeated ingestion, or
bridge joins cannot multiply source weight.

Source trust is bounded from zero to one and combines:

- a configured prior for the source category;
- successful, complete-enough harvesting;
- exact seed co-occurrence and seed coverage;
- useful-track density with a size penalty;
- independence from already-counted owners, platforms, and source families.

Playlist titles and URLs may help discover a source, but they cannot establish
trusted evidence by themselves. An inaccessible or unharvested source cannot
enter the high-trust tier.

Candidate support should saturate as evidence accumulates rather than add
weights without limit. Correlated playlists from the same owner or platform
must be capped, with a modest bonus for genuinely independent cross-platform
support.

Initial safety limits are:

- maximum expansion depth: 1;
- maximum discovered sources per run: 12;
- maximum accepted tracks per source: 200;
- one absolute discovery deadline;
- canonical visited-source IDs and cursor-cycle detection.

Trust does not feed back recursively within the same run. Each recommendation
must retain an explanation path from root seeds through accepted sources to the
candidate.

## Spotify 2026 Capability Boundary

Spotify Development Mode changed in February 2026. New Development Mode client
IDs require a Premium account, are limited to one client ID per developer and
five authorized users, and expose a reduced endpoint set. The other-user
playlist endpoint `GET /users/{id}/playlists` has no replacement. Playlist
contents in the reduced model are available only for playlists owned by the
current user or playlists on which the user collaborates.

QRator will therefore use supported Spotify capabilities for:

- the current user's saved tracks through `GET /me/tracks`;
- the current user's playlists through `GET /me/playlists`;
- owned or collaborative playlist items;
- bounded track search for strict target resolution;
- explicit playlist creation and item insertion.

Arbitrary public Spotify playlist traversal is not a dependable Development
Mode discovery primitive. The supported user-mediated workarounds are:

1. paste or import an exported track list into QRator; or
2. use a Spotify client to copy the desired public playlist's tracks into a
   playlist owned by the authorized user, then ingest that owned playlist.

A public Spotify URL may be retained as a discovery hint or attribution link,
but QRator must not scrape its HTML for playlist contents. Broader behavior may
be enabled only behind a documented capability flag for an application that
has the necessary extended access.

Spotify rate-limit responses must honor the complete `Retry-After` value. A
run-wide request budget and deadline take precedence over retrying indefinitely.

References:

- [Spotify February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Spotify developer-access update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)
- [Spotify Web API rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)

## Staged Implementation

### Stage 1: Correctness and budgets

- make provenance writes idempotent;
- aggregate source support without join multiplication;
- replace additive trust duplication with bounded graph support;
- add page, item, request, and deadline budgets;
- cover scoring and traversal with deterministic fixtures.

### Stage 2: Resilient API foundation

- centralize per-host rate-limit state;
- honor full retry/reset metadata and surface partial results;
- add capability flags and diagnostics for unavailable integrations;
- preserve secrets only in ignored, owner-readable files.

### Stage 3: Official read integrations

- migrate SoundCloud discovery to official client-credentials OAuth;
- add bounded SoundCloud resolve, search, playlist, and user adapters;
- add Spotify current-user saved tracks and playlist ingestion;
- paginate Last.fm within explicit budgets and handle now-playing records.

### Stage 4: Resolution and target eligibility

- implement strict Spotify and SoundCloud resolvers;
- persist platform resolutions and their evidence;
- apply target eligibility before sequencing;
- validate match thresholds against a held-out fixture corpus.

### Stage 5: Publishing

- harden Spotify publishing with preflight, idempotent run state, and partial
  failure reporting;
- implement SoundCloud Authorization Code with PKCE and rotating refresh-token
  storage;
- canary private three-track SoundCloud playlists before larger publishes.

### Stage 6: Controlled rollout

- run discovery and scoring in shadow mode;
- record per-feature request, retry, rate-limit, and resolution metrics;
- exercise expired-token and partial-publish recovery;
- increase limits only after observed evidence supports doing so.

## Configuration Contract

`.env.example` contains placeholders for the eventual official SoundCloud
credentials, callback, feature flags, and trust-spider budgets. They are
reserved configuration names until their stages are implemented. Setting them
today must not be interpreted as enabling functionality.

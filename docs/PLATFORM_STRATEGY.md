# QRator Platform Strategy

Status: staged implementation in progress

Last reviewed: 2026-08-04

Implementation checkpoint (2026-08-04): provenance aggregation,
cooldown/partial-result foundations, official SoundCloud OAuth/string-URN
support, and bounded SoundCloud user-shelf discovery are active. Algorithmic
radio and similar-track feeds are not used as shelf evidence. See
[Implementation Status](IMPLEMENTATION_STATUS.md).

QRator maintains a local taste profile from explicit track judgments. Discovery
still calculates shelf evidence independently, then applies a separate bounded
taste adjustment based on exact-track, artist, and source history. The local
taste profile is the sole durable user-curation store. See [Memory
Model](MEMORY_MODEL.md).

### Credential-free ListenBrainz shelves

An explicit canonical `https://listenbrainz.org/user/<username>` URL is a
first-class, user-chosen shelf. QRator makes exactly one request to
ListenBrainz's public user top-recordings statistics endpoint, fixed to the
`half_yearly` range, offset zero, and a hard count of 100. Valid artist/title
rows become candidates directly; a recording MBID is useful but not required.

The user's raw listen count and selected time range are retained only as
provenance metadata. Listen count does not add ranking weight. This source does
not query MusicBrainz to fill missing identifiers, traverse similar users,
recurse into other profiles, require a ListenBrainz token, or automatically
turn a public user's listens into the local taste profile. A public profile is
read only when its canonical URL is explicitly supplied.

## Objective

QRator uses SoundCloud as its primary discovery surface, explicit public user
lists as secondary shelf inputs, and Spotify as a catalog resolver and
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

### Temporary experimental public-page reader

While application registration is pending, QRator contains a deliberately
unsupported escape hatch for result-driven personal runs. When
`QRATOR_EXPERIMENTAL_SOUNDCLOUD_SCRAPE=1` is set, an explicitly supplied
public SoundCloud URL may be read for track metadata already embedded in its
initial HTML hydration payload. Public user profiles may fall back once to
SoundCloud's public recent-upload RSS feed using the hydrated user URN. This is
not part of the supported provider architecture: it does not call `api-v2`,
inspect JavaScript bundles, discover or retain client IDs, publish,
authenticate, or recursively crawl.

The reader is disabled by default, accepts only HTTPS SoundCloud hosts, checks
DNS before each request and same-allowlist redirect, and caps redirects,
response bytes, accepted tracks, and the shared run deadline. Layout changes,
private shelves, and login walls fail loudly and return no invented result.
The official OAuth/URN adapter remains the replacement rather than an extension
of this reader.

## Official SoundCloud Integration

SoundCloud is also the default in-app review player. QRator first uses a known
candidate permalink, then attempts strict artist/title resolution through the
official API, and uses Spotify only when no exact SoundCloud playback source is
available. The player is an official provider iframe loaded after an explicit
user action; playback behavior is not inferred as taste feedback.

For explicitly supplied SoundCloud source URLs, the connected official API is
the primary hydrator. One bounded page of tracks, playlist contents, profile
uploads, or likes is combined with any seed-derived shelves in the same run.
The experimental public-page/RSS reader remains an additive fallback, and
recording-level deduplication merges source provenance rather than selecting one
provider as the sole truth.

For seed expansion, QRator uses a fixed one-hop traversal through documented
public endpoints: strict track search, bounded favoriter lists intersected
across two to twenty shortlist tracks, then bounded pages from profiles with at
least two hits. Documented playlist search contributes additional real
playlist candidates. A single playlist can qualify with two hits; hits spread
across several hand-made playlists can qualify the common owner profile. Seed
recordings are removed from recommendations. Each result names the likes list,
playlist, or profile-level playlist evidence that exposed it; radio,
related-user, and similar-track responses are not treated as shelves.

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

SoundCloud's numeric `id` field was deprecated with a June 30, 2025 migration
deadline. QRator will treat each resource's stable string `urn` as its opaque
primary platform identifier, including in persisted resolutions and endpoint
paths. It will not derive or retain the numeric portion as an application key.

SoundCloud publishing is feasible through the official API:

- resolve eligible candidates to stable SoundCloud track URNs;
- preflight the complete private playlist payload;
- create it with `POST /playlists`;
- update it with `PUT /playlists/{urn}` only through an explicit, recoverable
  publish operation.

QRator will persist URNs as its identifiers, but it will validate the current
OpenAPI playlist-track payload contract in a private three-track canary before
enabling publishing. It will use URNs only where the API accepts them and will
never silently derive or retain deprecated numeric IDs.

The first user-facing publishing path is implemented: local OAuth 2.1 PKCE,
owner-only token storage, exact artist/title resolution to string URNs, and
explicit private/public playlist creation. The private three-track publish
canary passed, and bounded user shelf traversal is now active for discovery.

References:

- [SoundCloud API guide](https://developers.soundcloud.com/docs/api/)
- [SoundCloud application registration](https://developers.soundcloud.com/docs/api/register-app)
- [SoundCloud rate limits](https://developers.soundcloud.com/docs/api/rate-limits.html)
- [SoundCloud numeric ID to string URN migration](https://developers.soundcloud.com/blog/urn-num-to-string/)

## Platform-Neutral Candidates and Target Eligibility

The canonical candidate record should contain normalized artist, title,
recording/version information, optional external identifiers, provenance, and
confidence. Platform resolution belongs in a separate structure keyed by
candidate and target:

| Target | Required eligibility evidence |
| --- | --- |
| Spotify | A strictly matched Spotify track URI with confidence above the configured threshold |
| SoundCloud | A playable SoundCloud track URN with confidence above the configured threshold |
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

Automatic expansion is restricted to an HTTPS provider allowlist. Generic URLs
entered manually remain explicit one-hop inputs. Before every request and
redirect, QRator must reject embedded credentials, loopback, private,
link-local, and multicast destinations after DNS resolution; redirect count and
domain changes are capped. Content type, response bytes, and decompressed size
are bounded. These controls remain mandatory even when depth and request
budgets have room remaining.

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

Spotify Development Mode changed in February 2026. Development Mode requires
the app owner to have Premium and permits five authorized users per app. As of
the July 2026 change, a developer may create up to 25 client IDs, but their
Development Mode clients share quota buckets at the developer-account level.
The other-user playlist endpoint `GET /users/{id}/playlists` has no replacement.
Playlist contents in the reduced model are available only for playlists owned
by the current user or playlists on which the user collaborates.

QRator will therefore use supported Spotify capabilities for:

- the current user's saved tracks through `GET /me/tracks`;
- the current user's playlists through `GET /me/playlists`;
- owned or collaborative playlist items;
- bounded track search for strict target resolution;
- explicit playlist creation and item insertion.

Spotify search remains available with a maximum page size of 10 and remains
useful for strict track resolution. The current playlist-items reference lists
`playlist-read-private`; access is still limited to owned or collaborative
playlists. `/me/playlists` may also enumerate followed playlists, so enumeration
alone is not proof that contents are readable: QRator verifies the supplied
profile against `/me`, filters ownership/collaboration metadata, and treats 403
as an expected capability denial, never as a trigger for HTML scraping. The
current response wrapper is `items[].item`; the legacy `items[].track` wrapper
is accepted only as a compatibility fallback.

Arbitrary public Spotify playlist traversal is not a dependable Development
Mode discovery primitive. The supported user-mediated workarounds are:

1. paste or import an exported track list into QRator; or
2. use a Spotify client to copy the desired public playlist's tracks into a
   playlist owned by the authorized user, then ingest that owned playlist.

A public Spotify URL may be retained as a discovery hint or attribution link,
but QRator must not scrape its HTML for playlist contents. Broader behavior may
be enabled only behind a documented capability flag for an application that
has the necessary extended access.

Extended Quota applications remain outside the Development Mode restrictions.
QRator still probes behavior gracefully rather than inferring capability from
an application's creation date.

Spotify rate-limit responses must honor the complete `Retry-After` value. A
An ordinary 429 may wait within that budget or return partial results. A 429
whose structured reason is `QUOTA_EXCEEDED` is developer-account quota
exhaustion under the July 2026 model: QRator records any supplied cooldown but
does not retry it inside the current request.

References:

- [Spotify February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Spotify July 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)
- [Spotify playlist-items reference](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
- [Spotify developer-access update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)
- [Spotify Web API rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)

## Storage, Authorization, and Privacy

The platform-neutral rewrite needs versioned transactional SQLite migrations,
not ad-hoc `ALTER TABLE` checks. A `schema_version` ledger, foreign-key
enforcement, provider-identifier uniqueness, and an idempotent provenance key
will support backfills from the current `spotify_uri` and `soundcloud_url`
columns. Migration fixtures must cover artist/title collisions, remix/live/edit
variants, repeated runs, rollback on failure, and persistent CLI databases.
Compatibility reads remain until a migrated database passes validation.

Publishing requires more than resolver confidence. Each item must have explicit
user selection, immutable membership in the reviewed discovery run, target
capability, unambiguous resolution evidence with algorithm version and
verification time, and a durable publish-item state. Ambiguous or stale
resolutions fail closed.

OAuth refresh is single-flight across processes. The token store serializes
refresh per application/user, atomically compares token generations, writes
owner-readable state before releasing the lock, and recovers interrupted
refreshes. This is essential for SoundCloud's rotating refresh tokens and also
prevents redundant Spotify refreshes.

The shared broker keeps durable rolling-window permit and cooldown state,
separates token-exchange quotas from API request quotas, uses a monotonic clock
for waits, cleans abandoned permits, and bounds ledger retention. Provider
payloads are redacted, size-limited, and subject to a short TTL; tokens and URLs
containing credentials are never retained as diagnostics.

## Staged Implementation

### Stage 1: Correctness and budgets

- make provenance writes idempotent;
- aggregate source support without join multiplication;
- replace additive trust duplication with bounded graph support;
- add page, item, request, and deadline budgets;
- cover scoring and traversal with deterministic fixtures.

### Stage 2: Resilient API foundation

- coordinate rate-limit state in one broker shared by concurrent Node and
  Python processes and discovery runs, keyed by provider and application
  identity rather than held only in process memory;
- enforce a bounded, fair wait queue with per-run deadlines and cancellation,
  removing queued work when its request disconnects, expires, or is cancelled;
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

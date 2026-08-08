# QRator Implementation Status

Last updated: 2026-08-04

## Working now

- SoundCloud-first seed expansion through actual public user curation. QRator
  resolves two to twenty shortlist tracks, samples up to 1,000 likers per
  track, intersects profiles, and hydrates at most 25 profiles that overlap on
  at least two tracks. Direct search adds up to 20 playlist candidates per seed.
  A single playlist qualifies with two hits; distributed hits across multiple
  hand-made playlists can qualify their shared owner profile.
- Algorithmic ListenBrainz artist radio and Last.fm similar-track feeds are no
  longer generated or scored as shelves.
- Automatic web-mode routing: bounded artist/track seeds use SoundCloud shelf
  expansion, while URLs and larger pasted source material use distillation.
- Explicit public ListenBrainz user shelves through one official six-month
  top-recordings request. Inputs require an exact canonical profile URL; the
  request is fixed to offset zero and at most 100 rows, and does not traverse
  similar users.
- Bulk recording hydration through ListenBrainz/MusicBrainz identifiers.
- Platform-neutral review: candidates survive without a Spotify URI.
- Clickable Spotify, MusicBrainz, YouTube-search, and SoundCloud-search routes.
- Strict Spotify matching with version awareness, persistent positive/negative
  caching, and a configurable per-run query budget.
- Durable Spotify cooldown shared by the Node server and Python subprocesses.
- Full `Retry-After` handling with bounded waits and partial-result behavior.
- Spotify 2026 playlist compatibility: current `item.item` and legacy
  `item.track` wrappers, authenticated identity checks for profile ingestion,
  owned/collaborative filtering, and separate 403, ordinary 429, and
  `QUOTA_EXCEEDED` classifications.
- Idempotent provenance edges and one effective source weight per candidate.
- Generic `platform_resolutions` storage alongside compatibility columns.
- Spotify publishing preflight: QRator resolves first and will not create an empty
  playlist.
- Ephemeral discovery runs with a durable, local profile built from explicit
  **More like this** and **Less like this** judgments.
- Separate shelf confidence, discovery distance, and recording confidence instead
  of a monolithic taste-like score.
- Persistent taste review controls. Positive tracks can seed the next expansion;
  negative tracks are excluded from expansion and publishing. Exact-track,
  artist, and source signals apply a separate bounded adjustment to later
  discovery ordering without overwriting shelf confidence.
- An inspectable taste-profile view with aggregate signals, JSON export,
  individual removal, and complete erasure. The owner-only profile is QRator's
  sole durable user-curation store.
- A single persistent review player with SoundCloud-first resolution: known
  candidate URL, strict official API match, then Spotify embed fallback. The
  external provider frame loads only after **Play here** and survives review-list
  rerenders.
- Spotify publishing accepts the current non-skipped mix only after validating
  every candidate identifier against the short-lived discovery run. Neutral
  candidates remain included; **Keep** is a priority/next-seed marker, not an
  exclusive-membership toggle.
- Browser controls and default rendering initialize before status or profile
  requests. Provider status failures degrade visibly; slow status and profile
  reads do not leave forms or tabs inert.
- The pre-run discovery empty state now obeys its `hidden` attribute after a
  successful run. Browser regression verifies zero layout height and visible
  shortlist/actions at 1920×1080 and 1280×720.
- Disabled-by-default experimental ingestion of hydration metadata from an
  explicitly supplied public SoundCloud page. It is host-, redirect-, byte-,
  item-, and deadline-bounded and never calls `api-v2` or extracts a client ID.
- Official SoundCloud OAuth 2.1 Authorization Code + PKCE connection for the
  local user, with ten-minute single-use state, PKCE verifier, atomic
  owner-only token storage, and refresh-token rotation.
- Official SoundCloud search and explicit playlist publishing using the current
  string-URN API contract. QRator resolves every selected candidate first,
  rejects non-exact artist/title results, and refuses to create an empty
  playlist. A SoundCloud publish may be private or public by the explicit GUI
  toggle; unresolved tracks are reported rather than substituted. SoundCloud
  publishing is a first-class shortlist action rather than a secondary control
  hidden behind the Spotify publish form.
- Official SoundCloud hydration for explicitly supplied track, playlist,
  profile-upload, and likes URLs, bounded to one page and 100 tracks. The
  experimental page/RSS reader remains an additive fallback.
- Mixed-source web runs combine explicit URL hydration, seed-derived SoundCloud
  user shelves, and late provider resolution. Duplicate recording keys merge
  provenance and identifiers before taste ranking.

## Deferred UI audit evidence

The synthetic browser audit on 2026-07-27 also reproduced a separate client
defect that remains intentionally deferred:

- Keep/Skip rerenders the whole discovery result and drops keyboard focus to the
  document body.

The CSS cascade defect that left the empty state above valid discovery results
is fixed. The focus defect remains bounded follow-up work and was not changed.

## SoundCloud publish canary — 2026-08-01

QRator completed the first live private publish canary through the documented
SoundCloud API. The local PKCE connection resolved and created a three-track
playlist from Nina Simone — *Sinnerman*, The Notorious B.I.G. — *Juicy*, and A
Tribe Called Quest — *Electric Relaxation*. All three were resolved to
SoundCloud string URNs by strict matching and accepted by `POST /playlists`;
there were zero unresolved candidates and no fallback substitutions. The
private playlist URL and OAuth credentials remain local runtime state and are
not recorded here.

## Large-shelf experiment — 2026-08-01

QRator ingested four explicitly supplied public SoundCloud playlists through
the official API, retained only tracks visible to the authenticated account,
deduplicated by string URN, and added a bounded Freddie Gibbs/collaborator
shelf through strict resolution. A source-proportional sequencer produced one
private 475-track playlist from 908 unique accessible tracks. This keeps 25
slots below SoundCloud's enforced 500-track ceiling so a later album can be
added without rebuilding the set. A second generated volume was explicitly
deleted when the user chose one experimental playlist rather than a series.

Two supplied Spotify public playlists remain pending: this Development Mode
application can read their top-level metadata but receives 403 for playlist
items. QRator did not scrape their HTML or claim those tracks were ingested.

## Intentionally disabled

- Spotify public-playlist HTML scraping.
- SoundCloud `api-v2` use and extraction of client IDs from web bundles.
- Arbitrary Spotify-user playlist traversal.
- Recursive or unattended SoundCloud crawling. Automatic discovery is a fixed,
  one-hop official-API traversal with hard seed, curator, playlist, and track
  limits; the experimental reader remains explicit-input and one-page-only.

## Next

1. Finish versioned backfill/validation for existing long-lived databases.
2. Add official SoundCloud client-credentials reads for credential-independent
   public operation; current official hydration uses the connected user token.
3. Move the proven large-shelf hydration, global URN deduplication, proportional
   sequencing, and resumable publish receipt into a maintained CLI workflow.
4. Promote the current human-readable SoundCloud shelf provenance to stable
   first-class shelf identifiers, then add explicit “raid this shelf deeper.”
5. Decide whether passive provider-history imports, recency decay, and richer
   taste facets belong in the profile; none are silently inferred today.
6. Expand deterministic scoring, traversal, and provider-failure fixtures.

## Active budgets

- Twenty seed tracks/artists accepted by the web parser.
- At most twelve new Spotify resolution searches by default
  (`QRATOR_SPOTIFY_RESOLVE_LIMIT`).
- At most fifteen seconds waiting inside a request for an existing provider
  cooldown (`QRATOR_MAX_RATE_LIMIT_WAIT_SECONDS`).
- A 180-second discovery deadline by default
  (`QRATOR_DISCOVERY_DEADLINE_SECONDS`).
- Experimental SoundCloud page reads: three redirects, 2 MiB, and 100 accepted
  tracks by default, with hard caps of three redirects, 4 MiB, and 200 tracks.
- SoundCloud seed discovery: two to twenty seeds, 20 directly searched playlist
  candidates per seed, up to five 200-profile liker pages per seed, at most 25
  qualifying overlap profiles, 100 tracks per likes/playlist shelf, and ten
  public playlists per qualified listener.
- Generated mixes accept 5–475 requested tracks. SoundCloud publish preflight
  accepts at most 500, leaving the generation ceiling below the provider cap
  while preserving source-balanced sequencing.
- ListenBrainz public user shelves: exactly one `half_yearly` top-recordings
  request at offset zero with a hard count of 100.

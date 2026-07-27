# QRator Implementation Status

Last updated: 2026-07-27

## Working now

- Keyless seed expansion through official ListenBrainz artist radio.
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
- Ephemeral discovery with no tracked or inferred personal taste profile.
- Separate shelf confidence, discovery distance, and recording confidence instead
  of a monolithic taste-like score.
- Explicit owner-only metadata archive with GUI inspection, JSON export, and
  per-track removal. Archive contents never feed ranking.
- Session-only keep/skip review controls. Kept tracks can seed the next
  expansion; skipped tracks are excluded from expansion and publishing.
  Judgments reset on the next run or reload and never enter durable storage.
- Spotify publishing accepts the current non-skipped mix only after validating
  every candidate identifier against the short-lived discovery run. Neutral
  candidates remain included; **Keep** is a priority/next-seed marker, not an
  exclusive-membership toggle.
- Browser controls and default rendering initialize before status or archive
  requests. Spotify status failures degrade visibly while credential-free
  ListenBrainz discovery remains usable; slow status and archive reads do not
  leave forms or tabs inert.
- The pre-run discovery empty state now obeys its `hidden` attribute after a
  successful run. Browser regression verifies zero layout height and visible
  shortlist/actions at 1920×1080 and 1280×720.
- Disabled-by-default experimental ingestion of hydration metadata from an
  explicitly supplied public SoundCloud page. It is host-, redirect-, byte-,
  item-, and deadline-bounded and never calls `api-v2` or extracts a client ID.

## Deferred UI audit evidence

The synthetic browser audit on 2026-07-27 also reproduced a separate client
defect that remains intentionally deferred:

- Keep/Skip rerenders the whole discovery result and drops keyboard focus to the
  document body.

The CSS cascade defect that left the empty state above valid discovery results
is fixed. The focus defect remains bounded follow-up work and was not changed.

## Intentionally disabled

- Spotify public-playlist HTML scraping.
- SoundCloud `api-v2` use and extraction of client IDs from web bundles.
- Arbitrary Spotify-user playlist traversal.
- Recursive or unattended SoundCloud crawling; the experimental reader is
  explicit-input, one-page-only, unsupported, and opt-in.

## Next

1. Finish versioned backfill/validation for existing long-lived databases.
2. Add official SoundCloud client-credentials reads with string URNs, bounded
   pagination, and capability diagnostics.
3. Add SoundCloud user OAuth, strict resolution, and a private three-track publish
   canary.
4. Add first-class shelf identifiers, then implement session-only “raid this
   shelf deeper” without conflating shelves with individual track seeds.
5. Add an opt-in persistent judgment store only after its inspect/export/erase
   controls and non-ranking boundaries are specified.
6. Expand deterministic scoring, traversal, and provider-failure fixtures.

## Active budgets

- Four seed artists accepted by the web parser.
- At most twelve new Spotify resolution searches by default
  (`QRATOR_SPOTIFY_RESOLVE_LIMIT`).
- At most fifteen seconds waiting inside a request for an existing provider
  cooldown (`QRATOR_MAX_RATE_LIMIT_WAIT_SECONDS`).
- A 180-second discovery deadline by default
  (`QRATOR_DISCOVERY_DEADLINE_SECONDS`).
- Experimental SoundCloud page reads: three redirects, 2 MiB, and 100 accepted
  tracks by default, with hard caps of three redirects, 4 MiB, and 200 tracks.
- ListenBrainz public user shelves: exactly one `half_yearly` top-recordings
  request at offset zero with a hard count of 100.

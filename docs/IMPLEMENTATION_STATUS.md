# QRator Implementation Status

Last updated: 2026-07-26

## Working now

- Keyless seed expansion through official ListenBrainz artist radio.
- Bulk recording hydration through ListenBrainz/MusicBrainz identifiers.
- Platform-neutral review: candidates survive without a Spotify URI.
- Clickable Spotify, MusicBrainz, YouTube-search, and SoundCloud-search routes.
- Strict Spotify matching with version awareness, persistent positive/negative
  caching, and a configurable per-run query budget.
- Durable Spotify cooldown shared by the Node server and Python subprocesses.
- Full `Retry-After` handling with bounded waits and partial-result behavior.
- Idempotent provenance edges and one effective source weight per candidate.
- Generic `platform_resolutions` storage alongside compatibility columns.
- Spotify publishing preflight: QRator resolves first and will not create an empty
  playlist.
- Ephemeral discovery with no tracked or inferred personal taste profile.
- Separate shelf confidence, discovery distance, and recording confidence instead
  of a monolithic taste-like score.
- Explicit owner-only metadata archive with GUI inspection, JSON export, and
  per-track removal. Archive contents never feed ranking.

## Intentionally disabled

- Spotify public-playlist HTML scraping.
- SoundCloud `api-v2` use and extraction of client IDs from web bundles.
- Arbitrary Spotify-user playlist traversal.

## Next

1. Finish versioned backfill/validation for existing long-lived databases.
2. Add official SoundCloud client-credentials reads with string URNs, bounded
   pagination, and capability diagnostics.
3. Add SoundCloud user OAuth, strict resolution, and a private three-track publish
   canary.
4. Add session-only “keep,” “skip,” and “raid this shelf deeper” controls.
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

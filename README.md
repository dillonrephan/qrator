# QRator Codex

For AI-piloted harvesting, use `node bin/qrator-curate.mjs harvest`, then
`validate` and explicitly authorized `publish`. See
[Agent operation](docs/AGENT_CURATION_PROTOCOL.md#agent-operation) for the JSON
contract. The Python seed-only command now fails instead of reporting success
after checking zero shelves; it is not the SoundCloud discovery entrypoint.

An independent QRator variant focused on isolated discovery runs, reviewable results, and explicit publishing.

The original project at `/home/ice/projects/spotify` is not modified or used for runtime state.

## Current Direction

QRator now treats SoundCloud's real public user curation as its primary
discovery surface. Two to four shortlist tracks are resolved on SoundCloud,
their liker lists are intersected across a bounded sample of profiles, and
qualifying public likes and playlists become inspectable shelves. A shelf needs
at least two distinct shortlist hits; one shared song is only a lead. Direct
playlist search and overlap distributed across several playlists owned by the
same profile are additive evidence.
Algorithmic artist-radio and similar-track feeds are not counted as shelves.
Spotify remains a capped, strict resolver and explicit publishing target rather
than the discovery engine.

An explicitly supplied canonical ListenBrainz profile URL can also be treated
as a trusted shelf. QRator reads one bounded page of that user's six-month top
recordings without authentication; listen counts remain provenance metadata
and do not become ranking weight.

SoundCloud-first discovery, playback, hydration, and publishing use the
official OAuth API. A bounded experimental reader remains available only as an
additive fallback for explicitly provided public SoundCloud pages. See
[Platform Strategy](docs/PLATFORM_STRATEGY.md) and
[Implementation Status](docs/IMPLEMENTATION_STATUS.md). QRator's default
ephemeral behavior and explicit archive boundary are documented in
[Memory Model](docs/MEMORY_MODEL.md).

QRator also has a local-first waveform and semantic perception instrument for
explicitly authorized audio. It does not upload recordings or silently infer a
durable taste profile. See [Local Audio Perception](docs/AUDIO_PERCEPTION.md).

## Setup

Create a Spotify Developer application with this redirect URI:

```text
http://127.0.0.1:8787/callback
```

Configure and start the app:

```bash
cp .env.example .env
chmod 600 .env
# Fill in the Spotify client ID and secret.
# SoundCloud connection enables seed-to-user-shelf discovery.
npm start
```

The default address is `http://127.0.0.1:8787`.

Install Python dependencies in an isolated environment:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
```

## Checks

```bash
npm run check
npm test
npm run test:browser
python -m compileall -q music_harvester
```

The browser regression uses an installed Chromium binary, a disposable profile,
and a loopback-only synthetic server. It does not start QRator's real server or
contact music providers. It verifies startup resilience and that successful
discovery removes the pre-run empty state from layout at 1920×1080 and
1280×720. Set `QRATOR_CHROMIUM` if Chromium is not installed at
`/usr/bin/chromium-browser`.

## Runtime Model

- The HTTP server listens only on loopback.
- Each discovery request runs in its own temporary directory and SQLite database.
- QRator builds a local taste profile from explicit **More like this** and
  **Less like this** judgments. Exact-track, artist, and source signals reorder
  later discoveries through a separate, visible taste adjustment.
- Discovery review has one click-to-load in-app player. QRator uses a known
  SoundCloud URL first, otherwise attempts a strict official SoundCloud match,
  and falls back to an available Spotify track embed. Only one provider frame
  is loaded at a time, after an explicit play action.
- Taste judgments survive runs and reloads, can be inspected, exported, or
  removed, and can be erased completely. They are stored owner-only at
  `data/taste-profile.json`, ignored by Git.
- Spotify authorization requests `user-top-read` so an explicitly requested
  run can use the account's top tracks as seeds. Provider history is never
  imported silently or converted into durable taste judgments.
- **More like this** prioritizes tracks as seeds for the next expansion, while
  **Less like this** excludes tracks from current expansion and publishing.
- Connected SoundCloud seed discovery uses only bounded public user likes and
  playlists as shelves. Every shelf needs at least two distinct shortlist hits,
  whether in one likes list, one hand-made playlist, or across several playlists
  owned by the same profile. It does not treat algorithmic radios as human
  curation.
- The web form automatically expands bounded seed input (up to twenty artist or
  track lines) through discovery. URLs and larger pasted tracklists stay on the
  source-distillation path instead of being mistaken for expansion seeds.
- Canonical `https://listenbrainz.org/user/<username>` inputs read one official
  top-recordings page: offset zero, `half_yearly`, and at most 100 rows. QRator
  does not traverse similar users, hydrate missing MBIDs, or score raw listen
  counts.
- Unsupported Spotify HTML scraping and SoundCloud web-client credential extraction are disabled.
- An opt-in experimental SoundCloud public-page reader uses only page hydration
  metadata and, for public profiles, SoundCloud's public recent-upload RSS feed:
  no `api-v2`, JavaScript-bundle mining, or persisted web-client credentials.
  It is bounded to SoundCloud HTTPS hosts, three redirects, 2 MiB, 100 tracks,
  and the run deadline, and may break when SoundCloud changes its HTML.
- Explicit SoundCloud URLs use the connected official API first for a bounded
  track, playlist, profile-upload, or likes-page hydration. The experimental
  page/RSS reader remains enabled as an additive fallback; it is not treated as
  successful when it exposes no tracks.
- Mixed input is additive: explicit source URLs and SoundCloud shelves found
  from bounded artist/track seeds can contribute to the same shortlist.
  Matching recording identities merge provider identifiers and source
  provenance instead of replacing one source with another.
- Final Spotify resolution is strict, persistently cached, and capped at twelve new queries by default.
- Spotify and Python discovery share a durable provider cooldown. Full `Retry-After`
  values are retained; long waits return useful partial results instead of hammering.
- Spotify playlist ingestion accepts the current `item` response shape and the
  legacy `track` wrapper. Development Mode profile inputs must identify the
  authenticated user; followed playlists owned by someone else are not silently
  read through `/me/playlists`.
- Spotify 403 playlist responses are reported as ownership/collaboration
  capability denials. Ordinary 429 responses retain cooldown/retry behavior,
  while July 2026 `QUOTA_EXCEEDED` responses are preserved as terminal,
  structured developer-account quota state for the current request.
- SoundCloud-only and catalog-only candidates remain in review output, with direct
  SoundCloud and YouTube search links when no publishable target resolution exists.
- Discovery length can be set from 5 to 475 tracks. Long mixes retain
  shelf-balanced selection instead of exhausting one source before moving to
  the next; SoundCloud publishing accepts up to the provider's 500-track cap.
- Every reviewed shortlist exposes a first-class **Publish to SoundCloud**
  action with playlist name and public/private controls. QRator strictly
  resolves the non-skipped mix and reports anything it could not add.
- Provenance observations are idempotent and source weight is aggregated once per
  candidate/source.
- Platform identifiers are also stored in `platform_resolutions`; legacy columns
  remain during the compatibility migration.
- Explicit Last.fm profile URLs can still harvest a user's six-month top tracks;
  Last.fm similar-track responses are not used as shelves.
- Temporary discovery files are removed whether the run succeeds or fails.
- Reviewed results are retained in memory for one hour and addressed by a random run ID.
- Spotify publishing requires the run ID returned by that exact discovery request.
- Request bodies are limited to 256 KiB.
- OAuth state values expire after ten minutes.
- `.env`, Spotify tokens, databases, and generated output are ignored by Git.
- The owner-only taste profile at `data/taste-profile.json` is ignored by Git.

## CLI

The Python pipeline remains available directly:

```bash
python -m music_harvester.main ingest
python -m music_harvester.main generate --mode balanced_discovery --length 40
python -m music_harvester.main write-spotify --playlist-name "QRator finds"
```

For bounded official SoundCloud seed discovery (connected account required):

```bash
node bin/qrator-curate.mjs harvest < harvest-request.json
```

To raid one explicitly chosen public ListenBrainz shelf without a key:

```bash
python -m music_harvester.main create-seeds \
  --source-url "https://listenbrainz.org/user/example" \
  --length 40
```

To explicitly raid a public SoundCloud user, likes page, or playlist through
the unsupported experimental reader:

```bash
QRATOR_EXPERIMENTAL_SOUNDCLOUD_SCRAPE=1 \
python -m music_harvester.main create-seeds \
  --source-url "https://soundcloud.com/example/likes" \
  --length 40
```

This route is intentionally off by default and accepts only URLs supplied by
the user; it does not recursively crawl arbitrary sites. Optional hard-capped
budgets are `QRATOR_SOUNDCLOUD_SCRAPE_MAX_BYTES` (maximum 4 MiB),
`QRATOR_SOUNDCLOUD_SCRAPE_MAX_ITEMS` (maximum 200), and
`QRATOR_SOUNDCLOUD_SCRAPE_MAX_REDIRECTS` (maximum 3).

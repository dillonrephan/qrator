# QRator Codex

An independent QRator variant focused on isolated discovery runs, reviewable results, and explicit publishing.

The original project at `/home/ice/projects/spotify` is not modified or used for runtime state.

## Current Direction

QRator now has a useful credential-free discovery lane: artist seeds expand
through the official ListenBrainz radio API, MusicBrainz supplies recording
identity, and every result remains visible even when Spotify cannot resolve it.
Spotify is a capped, strict resolver and explicit publishing target rather than
the discovery engine.

SoundCloud-first discovery and publishing remain the next supported provider
integration, using SoundCloud's official OAuth API. A disabled-by-default,
bounded experimental reader can ingest metadata embedded in an explicitly
provided public SoundCloud page while credentials are pending. See
[Platform Strategy](docs/PLATFORM_STRATEGY.md) and
[Implementation Status](docs/IMPLEMENTATION_STATUS.md). QRator's default
ephemeral behavior and explicit archive boundary are documented in
[Memory Model](docs/MEMORY_MODEL.md).

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
# Last.fm is optional. ListenBrainz artist-radio discovery needs no key.
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
python -m compileall -q music_harvester
```

## Runtime Model

- The HTTP server listens only on loopback.
- Each discovery request runs in its own temporary directory and SQLite database.
- QRator ships with no personal taste anchors and does not learn a durable taste
  profile by default.
- Review controls are session-only: **Keep for this mix** prioritizes tracks as
  seeds for the next expansion, while **Skip this one** excludes tracks from
  expansion and publishing. Both reset on the next run or page reload.
- The GUI's **Save this track's metadata forever** action is an explicit local
  archive operation. Saved metadata is never used for ranking and can be
  inspected, exported, or individually removed.
- Keyless artist discovery uses bounded ListenBrainz radio and bulk MusicBrainz metadata.
- Unsupported Spotify HTML scraping and SoundCloud web-client credential extraction are disabled.
- An opt-in experimental SoundCloud public-page reader uses only page hydration
  metadata and, for public profiles, SoundCloud's public recent-upload RSS feed:
  no `api-v2`, JavaScript-bundle mining, or persisted web-client credentials.
  It is bounded to SoundCloud HTTPS hosts, three redirects, 2 MiB, 100 tracks,
  and the run deadline, and may break when SoundCloud changes its HTML.
- Final Spotify resolution is strict, persistently cached, and capped at twelve new queries by default.
- Spotify and Python discovery share a durable provider cooldown. Full `Retry-After`
  values are retained; long waits return useful partial results instead of hammering.
- SoundCloud-only and catalog-only candidates remain in review output, with direct
  SoundCloud and YouTube search links when no publishable target resolution exists.
- Provenance observations are idempotent and source weight is aggregated once per
  candidate/source.
- Platform identifiers are also stored in `platform_resolutions`; legacy columns
  remain during the compatibility migration.
- Last.fm profile URLs harvest six-month top tracks; seed tracks also draw from Last.fm similar tracks when `LASTFM_API_KEY` is configured.
- Temporary discovery files are removed whether the run succeeds or fails.
- Reviewed results are retained in memory for one hour and addressed by a random run ID.
- Spotify publishing requires the run ID returned by that exact discovery request.
- Request bodies are limited to 256 KiB.
- OAuth state values expire after ten minutes.
- `.env`, Spotify tokens, databases, and generated output are ignored by Git.
- The owner-only metadata archive at `data/saved-tracks.json` is also ignored by Git.

## CLI

The Python pipeline remains available directly:

```bash
python -m music_harvester.main ingest
python -m music_harvester.main generate --mode balanced_discovery --length 40
python -m music_harvester.main write-spotify --playlist-name "QRator finds"
```

For a useful no-key discovery run today:

```bash
python -m music_harvester.main discover-from-seeds \
  --artists Björk "MF DOOM" "Boards of Canada" "Fela Kuti" \
  --length 20
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

# QRator Codex

An independent QRator variant focused on isolated discovery runs, reviewable results, and explicit publishing.

The original project at `/home/ice/projects/spotify` is not modified or used for runtime state.

## Current Direction

QRator now has a useful credential-free discovery lane: artist seeds expand
through the official ListenBrainz radio API, MusicBrainz supplies recording
identity, and every result remains visible even when Spotify cannot resolve it.
Spotify is a capped, strict resolver and explicit publishing target rather than
the discovery engine.

SoundCloud-first discovery and publishing remain the next provider integration,
using only SoundCloud's official OAuth API. See
[Platform Strategy](docs/PLATFORM_STRATEGY.md) and
[Implementation Status](docs/IMPLEMENTATION_STATUS.md).

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
- Keyless artist discovery uses bounded ListenBrainz radio and bulk MusicBrainz metadata.
- Unsupported Spotify HTML scraping and SoundCloud web-client credential extraction are disabled.
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
  --artists Portishead Igorrr "Danny Brown" "Aphex Twin" \
  --length 20
```

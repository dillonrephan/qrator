# QRator Codex

An independent QRator variant focused on isolated discovery runs, reviewable results, and explicit Spotify publishing.

The original project at `/home/ice/projects/spotify` is not modified or used for runtime state.

## Direction

The next foundation phase is SoundCloud-first discovery using SoundCloud's
official API, while keeping candidates platform-neutral and treating publishing
destinations as explicit eligibility targets. Spotify remains a supported
resolver and publishing target within its current Development Mode limits.

See [Platform Strategy](docs/PLATFORM_STRATEGY.md) for the intended API,
trust-spider, eligibility, migration, and rollout design. That document is
forward-looking; the current behavior described below has not yet been changed.

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
# Add a Last.fm API key to enable profile and similar-track discovery.
npm start
```

The default address is `http://127.0.0.1:8787`.

Install Python dependencies when they are not already available:

```bash
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
- Spotify playlist discovery is capped at one search and one playlist per run; large playlists sample eight positions in normal mode.
- SoundCloud discovery is capped at three queries and twelve unique playlists per run.
- Final Spotify resolution uses one cached query per unique track and stops on rate limiting.
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

# Spotify profile overlap research

QRator includes a browser-assisted research path for comparing the public
playlists on one explicitly supplied Spotify profile. It is intended for
bounded shelf analysis, not general Spotify crawling.

## What it does

- Runs Spotify inside the workspace's isolated virtual monitor with a
  disposable Firefox profile.
- Enumerates public playlist links rendered by Spotify.
- Visits each playlist and captures its numbered track rows while handling
  Spotify's virtualized scrolling.
- Preserves repeated positions within one playlist but counts a recording only
  once per playlist when calculating cross-playlist recurrence.
- Checkpoints after every playlist and keeps generated output under the
  Git-ignored `output/` directory.
- Can merge targeted recollections before producing a ranked overlap report.

Profile order can be used as a rough current-versus-archive proxy, but Spotify
does not expose a verified playlist creation timestamp in this view. A repeated
track is evidence of shelf recurrence, not proof that it was played during a
livestream.

## Security boundary

Use a private, temporary clone of the user's Firefox profile only after the
user explicitly approves authenticated-session use. Never print browser
cookies or authorization headers. Erase the cloned profile and shut down the
isolated monitor after collection. Generated snapshots contain only public
profile, playlist, and track metadata and are written owner-only.

The retained collector does not read Firefox cookie databases or export a web
token. An early direct-token prototype was intentionally removed after Spotify
blocked the token endpoint and rate-limited the REST API.

## Collection

With an authenticated disposable Firefox already running on a private virtual
monitor and WebDriver BiDi listening locally:

```bash
node tools/spotify-browser-overlap.mjs \
  'https://open.spotify.com/user/USER_ID' \
  --bidi ws://127.0.0.1:9223/session \
  --out output/profile-overlap
```

Useful bounded options:

```text
--limit N                 collect only the first N rendered playlists
--only ID_ONE,ID_TWO      recollect only the listed playlist IDs
```

`tools/spotify-bidi-inspect.mjs` provides read-only DOM and scroll-geometry
inspection for diagnosing a changed Spotify layout.

## Finalization

After a targeted recollection, merge it into the full run and create the
ranked report:

```bash
node tools/finalize-spotify-overlap.mjs \
  output/profile-overlap/snapshot.json \
  output/profile-recheck/snapshot.json \
  output/profile-overlap
```

The finalizer writes:

- `final-snapshot.json`: full public metadata and calculated recurrence;
- `overlap-report.md`: ranked current-facing repeats and playlist overlap;
- `start-here.txt`: a compact 100-track listening shortlist.

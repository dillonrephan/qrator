import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  candidateArchiveId,
  chooseDiscoveryMode,
  discoverSoundcloudShelves,
  diversifyAcrossShelves,
  isStrictSoundcloudMatch,
  mergeHydratedCandidates,
  parseDiscoveryInput,
  parseLength,
  playbackChoice,
  rankCandidatesForTaste,
  readJson,
  readTasteProfile,
  selectRunItems,
  spotifyError,
  summarizeTasteProfile,
  soundcloudCandidateFromTrack,
  tasteJudgmentSnapshot,
  writeTasteProfile,
} from '../src/server.js';

test('SoundCloud resolution requires the same artist and recording title', () => {
  const candidate = { artist: 'Nina Simone', title: 'Sinnerman' };
  assert.equal(isStrictSoundcloudMatch(candidate, {
    title: 'Sinnerman', metadata_artist: 'Nina Simone', urn: 'soundcloud:tracks:1',
  }), true);
  assert.equal(isStrictSoundcloudMatch(candidate, {
    title: 'Sinnerman (Live Remix)', metadata_artist: 'Nina Simone', urn: 'soundcloud:tracks:2',
  }), false);
  assert.equal(isStrictSoundcloudMatch(candidate, {
    title: 'Sinnerman', metadata_artist: 'Another Artist', urn: 'soundcloud:tracks:3',
  }), false);
  assert.equal(isStrictSoundcloudMatch(candidate, {
    title: 'Nina Simone - Sinnerman', user: { username: 'archive channel' }, urn: 'soundcloud:tracks:4',
  }), true);
});

test('playback prefers a known SoundCloud source over Spotify', () => {
  const playback = playbackChoice({
    artist: 'Nina Simone',
    title: 'Sinnerman',
    soundcloud_url: 'https://soundcloud.com/nina-simone-official/sinnerman',
    spotify_uri: 'spotify:track:abc123',
  });
  assert.deepEqual(playback, {
    provider: 'soundcloud',
    url: 'https://soundcloud.com/nina-simone-official/sinnerman',
    resolution: 'candidate',
  });
});

test('playback accepts only a strict resolved SoundCloud match before Spotify', () => {
  const candidate = { artist: 'Nina Simone', title: 'Sinnerman', spotify_uri: 'spotify:track:abc123' };
  assert.equal(playbackChoice(candidate, {
    title: 'Sinnerman', metadata_artist: 'Nina Simone', urn: 'soundcloud:tracks:1',
    permalink_url: 'https://soundcloud.com/nina-simone-official/sinnerman',
  }).provider, 'soundcloud');
  assert.deepEqual(playbackChoice(candidate, {
    title: 'Sinnerman (Remix)', metadata_artist: 'Someone Else', urn: 'soundcloud:tracks:2',
    permalink_url: 'https://soundcloud.com/someone-else/sinnerman-remix',
  }), {
    provider: 'spotify',
    url: 'https://open.spotify.com/track/abc123',
    resolution: 'fallback',
  });
});

test('official SoundCloud hydration preserves playable identity', () => {
  const candidate = soundcloudCandidateFromTrack({
    kind: 'track',
    urn: 'soundcloud:tracks:1',
    title: 'Producer - Deep Cut',
    permalink_url: 'https://soundcloud.com/producer/deep-cut',
    user: { username: 'Producer' },
    publisher_metadata: { artist: 'Producer', album_title: 'Private Shelf' },
  }, 2);
  assert.equal(candidate.artist, 'Producer');
  assert.equal(candidate.title, 'Deep Cut');
  assert.equal(candidate.soundcloud_urn, 'soundcloud:tracks:1');
  assert.equal(candidate.soundcloud_url, 'https://soundcloud.com/producer/deep-cut');
  assert.deepEqual(candidate.sources, ['soundcloud_official_2']);
});

test('SoundCloud shelf discovery requires two shortlist hits and explains stronger overlap', async () => {
  const track = (urn, artist, title) => ({
    kind: 'track', urn, title, metadata_artist: artist, access: 'playable',
    permalink_url: `https://soundcloud.com/${artist.toLowerCase().replaceAll(' ', '-')}/${title.toLowerCase().replaceAll(' ', '-')}`,
    user: { username: artist },
  });
  const seed = track('soundcloud:tracks:seed', 'Of The Trees', 'Dolori');
  const secondSeed = track('soundcloud:tracks:second', 'The Glitch Mob', 'We Can Make the World Stop');
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url.toString());
    if (url.pathname === '/playlists') return { collection: [{
      kind: 'playlist', urn: 'soundcloud:playlists:search', title: 'Deep selections',
      user: { username: 'Playlist Keeper' }, tracks: [seed, secondSeed, track('soundcloud:tracks:p1', 'Other Artist', 'Playlist Find')],
    }] };
    if (url.pathname === '/tracks') {
      return { collection: [url.searchParams.get('q').includes('Dolori') ? seed : secondSeed] };
    }
    if (url.pathname.endsWith('/favoriters')) return { collection: [{ urn: 'soundcloud:users:listener', username: 'Good Ears' }] };
    if (url.pathname.endsWith('/likes/tracks')) return { collection: [seed, secondSeed, track('soundcloud:tracks:liked', 'Liked Artist', 'Liked Find')] };
    if (url.pathname.endsWith('/playlists')) return { collection: [{
      kind: 'playlist', urn: 'soundcloud:playlists:user', title: 'Good Ears set',
      user: { username: 'Good Ears' }, tracks: [seed, secondSeed, track('soundcloud:tracks:userp', 'Shelf Artist', 'Shelf Find')],
    }] };
    throw new Error(`Unexpected SoundCloud request: ${url}`);
  };

  const discovered = await discoverSoundcloudShelves([
    'Of The Trees - Dolori',
    'The Glitch Mob - We Can Make the World Stop',
  ], true, fetcher);

  assert.deepEqual(discovered.items.map((item) => item.title).sort(), ['Liked Find', 'Playlist Find', 'Shelf Find']);
  assert.equal(discovered.items.some((item) => item.title === 'Dolori'), false);
  assert.equal(discovered.items.some((item) => item.title === 'We Can Make the World Stop'), false);
  assert.equal(discovered.shelves.some((shelf) => shelf.startsWith('SoundCloud likes · Good Ears')), true);
  assert.equal(discovered.shelves.filter((shelf) => shelf.startsWith('SoundCloud playlist ·')).length, 2);
  assert.match(discovered.report, /at least two distinct hits/);
  assert.match(discovered.items.find((item) => item.title === 'Liked Find').why, /liked 2 distinct tracks/);
  assert.match(discovered.items.find((item) => item.title === 'Shelf Find').why, /contains 2 distinct tracks/);
  assert.equal(calls.some((url) => url.includes('/favoriters')), true);
  assert.equal(calls.some((url) => url.includes('/likes/tracks')), true);
});

test('one shared liked track does not qualify a SoundCloud shelf', async () => {
  const seed = {
    kind: 'track', urn: 'soundcloud:tracks:seed', title: 'Dolori', metadata_artist: 'Of The Trees',
    access: 'playable', permalink_url: 'https://soundcloud.com/ofthetrees/dolori', user: { username: 'Of The Trees' },
  };
  const fetcher = async (url) => {
    if (url.pathname === '/playlists') return { collection: [] };
    if (url.pathname === '/tracks') return { collection: [seed] };
    if (url.pathname.endsWith('/favoriters')) return { collection: [{ urn: 'soundcloud:users:listener', username: 'One Hit' }] };
    throw new Error(`Single-hit traversal should not hydrate a shelf: ${url}`);
  };
  const discovered = await discoverSoundcloudShelves(['Of The Trees - Dolori'], true, fetcher);
  assert.deepEqual(discovered.items, []);
  assert.deepEqual(discovered.shelves, []);
  assert.match(discovered.report, /One shared track is not treated as shelf evidence/);
});

test('distributed hits across several playlists qualify the curator profile', async () => {
  const track = (urn, artist, title) => ({
    kind: 'track', urn, title, metadata_artist: artist, access: 'playable',
    permalink_url: `https://soundcloud.com/test/${urn.split(':').at(-1)}`, user: { username: artist },
  });
  const first = track('soundcloud:tracks:first', 'Artist One', 'Seed One');
  const second = track('soundcloud:tracks:second', 'Artist Two', 'Seed Two');
  const owner = { urn: 'soundcloud:users:curator', username: 'Wide Listener' };
  const fetcher = async (url) => {
    const firstQuery = url.searchParams.get('q')?.includes('Seed One');
    if (url.pathname === '/playlists') return { collection: [{
      kind: 'playlist', urn: firstQuery ? 'soundcloud:playlists:first' : 'soundcloud:playlists:second',
      title: firstQuery ? 'Volume One' : 'Volume Two', user: owner,
      tracks: [firstQuery ? first : second, track(firstQuery ? 'soundcloud:tracks:p1' : 'soundcloud:tracks:p2', 'New Artist', firstQuery ? 'Find One' : 'Find Two')],
    }] };
    if (url.pathname === '/tracks') return { collection: [firstQuery ? first : second] };
    if (url.pathname.endsWith('/favoriters')) return { collection: [] };
    throw new Error(`Unexpected request: ${url}`);
  };

  const discovered = await discoverSoundcloudShelves(['Artist One - Seed One', 'Artist Two - Seed Two'], true, fetcher);

  assert.deepEqual(discovered.items.map((item) => item.title).sort(), ['Find One', 'Find Two']);
  assert.deepEqual(discovered.shelves, ['SoundCloud profile playlists · Wide Listener']);
  assert.match(discovered.items[0].why, /2 distinct shortlist tracks across 2 hand-made/);
});

test('multi-source hydration merges identifiers and provenance by recording', () => {
  const merged = mergeHydratedCandidates([
    {
      artist: 'Producer', title: 'Deep Cut', soundcloud_urn: 'soundcloud:tracks:1', soundcloud_url: 'https://soundcloud.com/producer/deep-cut',
      sources: ['soundcloud_official_1'], shelf_confidence: 85, recording_confidence: 90,
    },
    {
      artist: 'producer', title: 'deep cut', spotify_uri: 'spotify:track:abc123',
      musicbrainz_id: '9763ea5d-9a9c-4c9a-926b-46c4be85e06d', sources: ['user_shelf_1'],
      shelf_confidence: 73.4, recording_confidence: 100,
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].spotify_uri, 'spotify:track:abc123');
  assert.equal(merged[0].soundcloud_urn, 'soundcloud:tracks:1');
  assert.equal(merged[0].soundcloud_url, 'https://soundcloud.com/producer/deep-cut');
  assert.equal(merged[0].recording_confidence, 100);
  assert.deepEqual(merged[0].sources, ['soundcloud_official_1', 'user_shelf_1']);
});

test('shortlists distribute early slots across real shelves', () => {
  const items = [
    { title: 'A1', sources: ['Shelf A'] },
    { title: 'A2', sources: ['Shelf A'] },
    { title: 'A3', sources: ['Shelf A'] },
    { title: 'B1', sources: ['Shelf B'] },
    { title: 'C1', sources: ['Shelf C'] },
  ];
  assert.deepEqual(
    diversifyAcrossShelves(items, 5).map((item) => item.title),
    ['A1', 'B1', 'C1', 'A2', 'A3'],
  );
});

test('parses track seeds and source URLs without mixing them', () => {
  const result = parseDiscoveryInput([
    'Sister Nancy - Bam Bam',
    'Freddie Gibbs - Andrea',
    'https://example.com/tracklist',
  ].join('\n'));

  assert.equal(result.seedType, '--tracks');
  assert.deepEqual(result.seeds, ['Sister Nancy - Bam Bam', 'Freddie Gibbs - Andrea']);
  assert.deepEqual(result.urls, ['https://example.com/tracklist']);
});

test('parses one track as a track seed for continuous review expansion', () => {
  const result = parseDiscoveryInput('Björk - Jóga');
  assert.equal(result.seedType, '--tracks');
  assert.deepEqual(result.seeds, ['Björk - Jóga']);
});

test('parses artist seeds', () => {
  const result = parseDiscoveryInput('Igorrr + Freddie Gibbs');
  assert.equal(result.seedType, '--artists');
  assert.deepEqual(result.seeds, ['Igorrr', 'Freddie Gibbs']);
});

test('automatically expands bounded seed input and distills larger sources', () => {
  const artists = 'Björk\nMF DOOM';
  assert.equal(chooseDiscoveryMode('auto', artists), 'discover');
  assert.equal(chooseDiscoveryMode(undefined, 'Björk + MF DOOM'), 'discover');
  assert.equal(chooseDiscoveryMode('auto', 'https://listenbrainz.org/user/example'), 'distill');
  assert.equal(chooseDiscoveryMode('auto', [
    ...Array.from({ length: 21 }, (_, index) => `Artist ${index} - Track ${index}`),
  ].join('\n')), 'distill');
  assert.equal(chooseDiscoveryMode('distill', artists), 'distill');
  assert.equal(chooseDiscoveryMode('discover', 'Freddie Gibbs - Thug Psalms'), 'discover');
});

test('accepts only whole playlist lengths in range', () => {
  assert.equal(parseLength(5), 5);
  assert.equal(parseLength('30'), 30);
  assert.equal(parseLength(475), 475);
  for (const value of [4, 476, 'nope', 10.5]) {
    assert.throws(() => parseLength(value), { message: /whole number from 5 to 475/ });
  }
});

test('publishing selection preserves the validated current mix', () => {
  const items = [
    { artist: 'A', title: 'One' },
    { artist: 'B', title: 'Two' },
    { artist: 'C', title: 'Three' },
  ];
  const ids = items.map(candidateArchiveId);

  assert.equal(selectRunItems(items, undefined), items);
  assert.deepEqual(selectRunItems(items, [ids[2], ids[0], ids[2]]), [items[2], items[0]]);
  assert.throws(
    () => selectRunItems(items, ['metadata:not-from-this-run']),
    { message: /outside this discovery run/ },
  );
  assert.throws(() => selectRunItems(items, []), { message: /at least one track in the current mix/ });
});

test('reads valid JSON request bodies', async () => {
  const request = Readable.from([Buffer.from('{"query":"test"}')]);
  assert.deepEqual(await readJson(request), { query: 'test' });
});

test('rejects malformed and oversized JSON request bodies', async () => {
  await assert.rejects(readJson(Readable.from(['{'])), (error) => error.status === 400);
  await assert.rejects(readJson(Readable.from([Buffer.alloc(257 * 1024)])), (error) => error.status === 413);
});

test('preserves Spotify quota exhaustion as structured provider state', () => {
  const error = spotifyError(
    { status: 429 },
    { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } },
  );
  assert.equal(error.status, 429);
  assert.equal(error.reason, 'QUOTA_EXCEEDED');
  assert.match(error.message, /QUOTA_EXCEEDED/);
});

test('builds an inspectable taste summary from explicit judgments', () => {
  const judgments = [
    tasteJudgmentSnapshot({ artist: 'Björk', title: 'Jóga', sources: ['SoundCloud likes · listener'] }, 'keep', undefined, '2026-08-04T00:00:00.000Z'),
    tasteJudgmentSnapshot({ artist: 'Björk', title: 'Army of Me', sources: ['SoundCloud likes · listener'] }, 'keep', undefined, '2026-08-04T00:01:00.000Z'),
    tasteJudgmentSnapshot({ artist: 'Other', title: 'Nope', sources: ['another_shelf'] }, 'skip', undefined, '2026-08-04T00:02:00.000Z'),
  ];
  const summary = summarizeTasteProfile(judgments);
  assert.deepEqual({ total: summary.total, kept: summary.kept, skipped: summary.skipped }, { total: 3, kept: 2, skipped: 1 });
  assert.deepEqual(summary.artists[0], { label: 'Björk', kept: 2, skipped: 0, total: 2, net: 2 });
});

test('taste history transparently reorders candidates without changing shelf confidence', () => {
  const liked = { artist: 'Björk', title: 'Jóga', sources: ['SoundCloud likes · listener'], shelf_confidence: 70 };
  const judgments = [tasteJudgmentSnapshot(liked, 'keep', undefined, '2026-08-04T00:00:00.000Z')];
  const ranked = rankCandidatesForTaste([
    { artist: 'Neutral', title: 'High shelf', sources: ['other'], shelf_confidence: 75 },
    liked,
  ], judgments);
  assert.equal(ranked[0].title, 'Jóga');
  assert.equal(ranked[0].shelf_confidence, 70);
  assert.equal(ranked[0].taste_preference, 'keep');
  assert.ok(ranked[0].taste_adjustment > 0);
  assert.match(ranked[0].taste_reasons.join(' '), /marked this track/);
});

test('writes the taste profile owner-only and reads it back', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qrator-profile-test-'));
  const profilePath = path.join(directory, 'taste-profile.json');
  const judgments = [{ archive_id: 'metadata:test', preference: 'keep', artist: 'Artist', title: 'Track', sources: [] }];
  try {
    await writeTasteProfile(profilePath, judgments);
    assert.deepEqual(await readTasteProfile(profilePath), judgments);
    assert.equal((await stat(profilePath)).mode & 0o777, 0o600);
    const payload = JSON.parse(await readFile(profilePath, 'utf8'));
    assert.equal(payload.purpose, 'Local explicit taste judgments used to personalize QRator ranking.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

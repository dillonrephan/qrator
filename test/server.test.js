import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  candidateArchiveId,
  metadataSnapshot,
  parseDiscoveryInput,
  parseLength,
  readJson,
  readSavedTracks,
  selectRunItems,
  writeSavedTracks,
} from '../src/server.js';

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

test('parses artist seeds', () => {
  const result = parseDiscoveryInput('Igorrr + Freddie Gibbs');
  assert.equal(result.seedType, '--artists');
  assert.deepEqual(result.seeds, ['Igorrr', 'Freddie Gibbs']);
});

test('accepts only whole playlist lengths in range', () => {
  assert.equal(parseLength(5), 5);
  assert.equal(parseLength('30'), 30);
  assert.equal(parseLength(60), 60);
  for (const value of [4, 61, 'nope', 10.5]) {
    assert.throws(() => parseLength(value), { message: /whole number from 5 to 60/ });
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

test('creates an explicit metadata snapshot without taste or ranking state', () => {
  const candidate = {
    artist: 'Ruby My Dear',
    title: 'Robinet',
    album: 'Brame',
    spotify_uri: 'spotify:track:abc123',
    soundcloud_url: null,
    musicbrainz_id: '9763ea5d-9a9c-4c9a-926b-46c4be85e06d',
    sources: ['listenbrainz_radio'],
    score: 74.9,
    score_components: { seed_connection: 40.5 },
    why: 'Not archive material.',
    shelf_confidence: 74.9,
    recording_confidence: 100,
    discovery_distance: 'one shelf away',
  };
  const snapshot = metadataSnapshot(candidate, '2026-07-26T00:00:00.000Z');

  assert.equal(snapshot.archive_id, candidateArchiveId(candidate));
  assert.equal(snapshot.note, 'Explicit metadata archive; not used for ranking.');
  assert.equal(snapshot.score, undefined);
  assert.equal(snapshot.score_components, undefined);
  assert.equal(snapshot.why, undefined);
  assert.equal(snapshot.shelf_confidence, undefined);
  assert.equal(snapshot.recording_confidence, undefined);
  assert.equal(snapshot.discovery_distance, undefined);
});

test('writes the metadata archive owner-only and reads it back', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qrator-library-test-'));
  const archivePath = path.join(directory, 'saved-tracks.json');
  const tracks = [{ archive_id: 'metadata:test', artist: 'Artist', title: 'Track' }];
  try {
    await writeSavedTracks(archivePath, tracks);
    assert.deepEqual(await readSavedTracks(archivePath), tracks);
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
    const payload = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(payload.purpose, 'Explicitly saved track metadata. Never used for ranking.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

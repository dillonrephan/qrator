import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProviderSnapshot } from '../src/agent-snapshot.js';

const discovery = {
  runId: 'runtime-only-id',
  mode: 'discover',
  sources: 'SoundCloud shelf discovery: two human shelves qualified.',
  log: 'Authorization: Bearer should-never-survive',
  profileJudgments: 99,
  items: [
    {
      artist: 'First Artist',
      title: 'Exact Recording',
      soundcloud_urn: 'soundcloud:tracks:42',
      soundcloud_url: 'https://soundcloud.com/first/exact?utm_source=discarded',
      shelf_confidence: 91,
      recording_confidence: 94,
      sources: ['SoundCloud likes · Human One'],
      why: 'Human One liked two independent shortlist anchors.',
      taste_preference: 'keep',
    },
    {
      artist: 'First Artist',
      title: 'Exact Recording',
      soundcloud_urn: 'soundcloud:tracks:42',
      sources: ['SoundCloud playlist · Human Two'],
      shelf_confidence: 95,
    },
    {
      artist: 'Metadata Artist',
      title: 'Unresolved Recording',
      sources: ['Imported public track list'],
    },
  ],
};

test('provider snapshots are deterministic, content-addressed, and credential-minimal', () => {
  const first = normalizeProviderSnapshot(discovery);
  const second = normalizeProviderSnapshot(discovery);
  assert.deepEqual(first, second);
  assert.match(first.snapshot_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.candidate_count, 2);
  assert.equal(first.candidates[0].sources.length, 2);
  assert.equal(first.candidates[0].shelf_confidence, 95);
  assert.equal(first.candidates[0].soundcloud_url, 'https://soundcloud.com/first/exact');
  assert.equal(first.candidates[1].identity_strength, 'metadata-fallback');
  assert.equal(JSON.stringify(first).includes('Bearer'), false);
  assert.equal(JSON.stringify(first).includes('runtime-only-id'), false);
  assert.equal(JSON.stringify(first).includes('taste_preference'), false);
});

test('provider snapshots reject empty and oversized inputs', () => {
  assert.throws(() => normalizeProviderSnapshot({ items: [] }), /at least one usable candidate/);
  assert.throws(() => normalizeProviderSnapshot({ items: new Array(5_001) }), /at most 5000/);
});

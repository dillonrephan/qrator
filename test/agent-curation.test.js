import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCurationBrief,
  recordingKey,
  validateCurationProposal,
} from '../src/agent-curation.js';

const candidate = (artist, title, id, sources = ['SoundCloud likes · careful listener']) => ({
  artist,
  title,
  soundcloud_urn: `soundcloud:tracks:${id}`,
  soundcloud_url: `https://soundcloud.com/example/${id}?utm_source=test`,
  sources,
});

test('curation briefs are ephemeral and non-publishing by default', () => {
  const brief = normalizeCurationBrief({ objective: 'Dense, driven, melodic pressure.' });
  assert.equal(brief.memory.mode, 'ephemeral');
  assert.equal(brief.memory.label, null);
  assert.deepEqual(brief.publish, { requested: false, target: null, visibility: null });
  assert.equal(brief.constraints.exclude_reference_recordings, true);
});

test('durable recipes require an explicit mode and label', () => {
  assert.throws(
    () => normalizeCurationBrief({ objective: 'A useful mix.', memory: { mode: 'persistent' } }),
    /ephemeral or explicit-save/,
  );
  assert.throws(
    () => normalizeCurationBrief({ objective: 'A useful mix.', memory: { mode: 'explicit-save' } }),
    /human-readable label/,
  );
  assert.equal(normalizeCurationBrief({
    objective: 'A useful mix.',
    memory: { mode: 'explicit-save', label: 'Pressure without drift' },
  }).memory.label, 'Pressure without drift');
});

test('recording identity prefers provider IDs and strips tracking parameters from fallback URLs', () => {
  assert.equal(recordingKey(candidate('Artist', 'Track', '42')), 'soundcloud:tracks:42');
  assert.equal(recordingKey({
    artist: 'Artist', title: 'Track', soundcloud_url: 'https://soundcloud.com/artist/track?utm_source=noise',
  }), 'soundcloud-url:https://soundcloud.com/artist/track');
  assert.equal(recordingKey({ artist: 'Ártist', title: 'Track!' }), 'metadata:artist\ntrack');
});

test('proposal validation preserves AI order while enforcing reference, trait, and density boundaries', () => {
  const reference = candidate('Reference Artist', 'Already Used', 'old');
  const first = candidate('Anchor', 'First', '1');
  const secondByAnchor = candidate('Anchor', 'Second', '2');
  const reset = candidate('Reset', 'Handrail', '3');
  const avoided = candidate('Drifter', 'Clouds', '4');
  const result = validateCurationProposal({
    brief: {
      objective: 'Organized pressure with melodic handrails.',
      requested_length: 5,
      avoid_traits: ['airy'],
      constraints: { max_tracks_per_artist: 2, max_consecutive_by_artist: 1 },
    },
    reference_tracks: [reference],
    items: [
      { candidate: first, rationale: 'Immediate rhythmic grip.', traits: ['driven'], evidence: first.sources },
      { candidate: secondByAnchor, rationale: 'Useful, but needs a reset first.', traits: ['driven'], evidence: secondByAnchor.sources },
      { candidate: reset, rationale: 'Melody without losing momentum.', traits: ['melodic'], evidence: reset.sources },
      { candidate: secondByAnchor, rationale: 'Returns after the reset.', traits: ['driven'], evidence: secondByAnchor.sources },
      { candidate: secondByAnchor, rationale: 'An accidental duplicate.', traits: ['driven'], evidence: secondByAnchor.sources },
      { candidate: reference, rationale: 'Strong but already present.', traits: ['driven'], evidence: reference.sources },
      { candidate: avoided, rationale: 'Too diffuse for this brief.', traits: ['airy'], evidence: avoided.sources },
    ],
  });

  assert.deepEqual(result.accepted.map((item) => item.title), ['First', 'Handrail', 'Second']);
  assert.equal(result.rejected[0].reasons.includes('consecutive artist cap reached'), true);
  assert.equal(result.rejected[1].reasons.includes('duplicate recording'), true);
  assert.equal(result.rejected[2].reasons.includes('present in excluded reference material'), true);
  assert.equal(result.rejected[3].reasons.includes('avoided traits: airy'), true);
  assert.equal(result.receipt.reference_repeats_rejected, 1);
  assert.equal(result.receipt.unique_recordings, 3);
  assert.equal(result.receipt.publish.requested, false);
});

test('unsupported candidates fail closed with inspectable reasons', () => {
  const result = validateCurationProposal({
    brief: { objective: 'Evidence-backed selections.' },
    items: [{ artist: 'Unknown', title: 'Unsupported' }],
  });
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected[0].reasons, [
    'missing curator rationale',
    'missing shelf or curator evidence',
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCurationCommand } from '../src/agent-curation-command.js';

const run = (command, input) => runCurationCommand(
  command,
  typeof input === 'string' ? input : JSON.stringify(input),
);

test('brief command emits the normalized non-publishing contract', () => {
  const brief = run('brief', { objective: 'Fast, dense, and melodic.', requested_length: 60 });
  assert.equal(brief.requested_length, 60);
  assert.equal(brief.memory.mode, 'ephemeral');
  assert.equal(brief.publish.requested, false);
});

test('validate command emits accepted tracks and an inspectable receipt', () => {
  const result = run('validate', {
    brief: { objective: 'Pressure with a handrail.', requested_length: 5 },
    items: [{
      candidate: {
        artist: 'Example Artist',
        title: 'Exact Track',
        soundcloud_urn: 'soundcloud:tracks:42',
        sources: ['SoundCloud playlist · Human Shelf'],
      },
      rationale: 'Rhythmic pressure with a clear melodic center.',
      traits: ['driven', 'melodic'],
      evidence: ['SoundCloud playlist · Human Shelf'],
    }],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.receipt.unique_recordings, 1);
  assert.equal(result.receipt.publish.requested, false);
});

test('snapshot command emits a resumable allowlisted candidate document', () => {
  const snapshot = run('snapshot', {
    runId: 'not-durable',
    items: [{
      artist: 'Example Artist',
      title: 'Exact Track',
      soundcloud_urn: 'soundcloud:tracks:42',
      sources: ['SoundCloud playlist · Human Shelf'],
    }],
  });
  assert.equal(snapshot.kind, 'qrator-provider-snapshot');
  assert.equal(snapshot.candidate_count, 1);
  assert.equal(snapshot.candidates[0].recording_key, 'soundcloud:tracks:42');
  assert.equal('runId' in snapshot, false);
});

test('structurally invalid input fails closed with a stable message', () => {
  assert.throws(
    () => run('validate', '{ definitely not json'),
    { message: 'Curation input must be valid JSON.' },
  );
});

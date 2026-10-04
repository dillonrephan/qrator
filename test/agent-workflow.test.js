import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harvest, validate, publish } from '../src/agent-workflow.js';

const request = { brief: { objective: 'Test deliberate ordering', requested_length: 5 },
  seed_type: 'tracks', seeds: ['One - Reference', 'Two - Reference'] };
const candidate = id => ({ artist: `Artist ${id}`, title: `Track ${id}`,
  soundcloud_urn: `soundcloud:tracks:${id}`, sources: ['Human shelf'], shelf_confidence: 90 });
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qrator-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writes = [];
  const provider = {
    discoverSoundcloudShelves: async (seeds, trackSeeds, fetcher) => {
      await fetcher('https://api.soundcloud.com/playlists');
      return { items: [candidate('1'), candidate('2')], shelves: ['Human shelf'],
        profilesScanned: 2, errors: [], report: 'Fixture: two-seed overlap.' };
    },
    soundcloudFetch: async () => ({}),
    publishSoundcloudCandidates: async value => { writes.push(value); return { added: value.candidates.length }; },
    ...overrides,
  };
  return { directory, provider, writes };
}
const selection = run => ({ run_id: run.run_id, items: ['2', '1'].map(id => ({
  recording_key: `soundcloud:tracks:${id}`, rationale: 'Deliberate fixture order', traits: ['driven'],
})) });
const approved = run => ({ ...selection(run), publish: {
  confirmed: true, provider: 'soundcloud', name: 'Fixture only', visibility: 'private',
} });

test('harvest persists evidence; validate uses it and preserves agent order', async t => {
  const options = await setup(t);
  const run = await harvest(request, options);
  const result = await validate(selection(run), options);
  assert.deepEqual(result.accepted.map(c => c.title), ['Track 2', 'Track 1']);
  assert.deepEqual(result.accepted[0].evidence, ['Human shelf']);
  assert.equal(result.receipt.snapshot_id, run.snapshot.snapshot_id);
  assert.equal(options.writes.length, 0);
});

test('unknown tracks, injected evidence, missing rationale, and drift cannot publish', async t => {
  const options = await setup(t);
  const run = await harvest(request, options);
  await assert.rejects(validate({ run_id: run.run_id, items: [{ recording_key: 'soundcloud:tracks:fake' }] }, options), /outside/);
  const injected = selection(run); injected.items[0].evidence = ['fiction'];
  await assert.rejects(validate(injected, options), /only from/);
  const noRationale = approved(run); delete noRationale.items[0].rationale;
  await assert.rejects(publish(noRationale, options), /rejections/);
  const file = path.join(options.directory, `${run.run_id}.json`);
  const saved = JSON.parse(await readFile(file)); saved.snapshot.candidates[0].title = 'drift';
  await writeFile(file, JSON.stringify(saved));
  await assert.rejects(validate(selection(run), options), /integrity/);
  assert.equal(options.writes.length, 0);
});

test('publish requires explicit choice, is exact-order, all-resolved, and idempotent', async t => {
  const options = await setup(t);
  const run = await harvest(request, options);
  await assert.rejects(publish(selection(run), options), /Publish requires/);
  const first = await publish(approved(run), options);
  assert.deepEqual(await publish(approved(run), options), first);
  assert.equal(options.writes.length, 1);
  assert.equal(options.writes[0].requireAllResolved, true);
  assert.deepEqual(options.writes[0].candidates.map(c => c.title), ['Track 2', 'Track 1']);
  const changed = approved(run); changed.publish.name = 'Different';
  await assert.rejects(publish(changed, options), /already attempted/);
});

test('uncertain publication is never blindly retried', async t => {
  let calls = 0;
  const options = await setup(t, { publishSoundcloudCandidates: async () => { calls++; throw new Error('lost reply'); } });
  const run = await harvest(request, options);
  await assert.rejects(publish(approved(run), options), /lost reply/);
  await assert.rejects(publish(approved(run), options), /already attempted/);
  assert.equal(calls, 1);
});

test('zero shelves is failure; budget is enforced and partial output labelled', async t => {
  let calls = 0;
  const options = await setup(t, {
    soundcloudFetch: async () => { calls++; return {}; },
    discoverSoundcloudShelves: async (seeds, tracks, fetcher) => {
      const errors = [];
      for (let i = 0; i < 3; i++) try { await fetcher('https://api.soundcloud.com/tracks'); } catch(e) { errors.push(e.message); }
      return { items: [candidate('1')], shelves: ['Human shelf'], profilesScanned: 1, errors, report: 'Fixture' };
    },
  });
  const run = await harvest({ ...request, budget: { requests: 1, seconds: 5 } }, options);
  assert.equal(calls, 1);
  assert.equal(run.harvest.partial, true);
  assert.equal(run.harvest.budget_reached, true);
  options.provider.discoverSoundcloudShelves = async () => ({ items: [], shelves: [], errors: [] });
  await assert.rejects(harvest(request, options), /No qualifying shelves/);
});

test('invalid scope, one seed, unsupported overlap and path traversal fail closed', async t => {
  const options = await setup(t);
  await assert.rejects(harvest({ ...request, seeds: ['same', 'SAME'] }, options), /distinct/);
  await assert.rejects(harvest({ ...request, brief: { objective: 'test', constraints: { minimum_shelf_overlap: 3 } } }, options), /overlap/);
  await assert.rejects(validate({ run_id: '../../elsewhere', items: [] }, options), /run_id/);
});

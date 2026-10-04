// Agent orchestration over the existing harvester; no server or GUI required.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, lstat, open, rename } from 'node:fs/promises';
import { normalizeCurationBrief, validateCurationProposal } from './agent-curation.js';
import { normalizeProviderSnapshot } from './agent-snapshot.js';

const RUN_ID = /^[0-9a-f-]{36}$/;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defaultDirectory = () => path.join(os.homedir(), '.local/state/qrator/agent-runs');

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('Agent run directory must be private and owned by this user.');
}

async function saveExclusive(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}

async function readPrivate(file) {
  const { constants } = await import('node:fs');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077)
        || before.nlink !== 1 || before.size > 16 * 1024 * 1024)
      throw new Error('Unsafe agent run file.');
    const raw = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) throw new Error('Agent run changed during read.');
    return JSON.parse(raw.subarray(0, offset).toString('utf8'));
  } finally { await handle.close(); }
}

async function loadRun(directory, id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error('A saved harvest run_id is required.');
  const run = await readPrivate(path.join(directory, `${id}.json`));
  const { integrity, ...payload } = run;
  if (run.run_id !== id || integrity !== digest(payload)) throw new Error('Harvest integrity check failed.');
  return run;
}

export async function harvest(document, options = {}) {
  const brief = normalizeCurationBrief(document.brief);
  if (brief.constraints.minimum_shelf_overlap !== 2)
    throw new Error('The existing harvester qualifies two-seed overlap; minimum_shelf_overlap must be 2.');
  if (!['tracks', 'artists'].includes(document.seed_type)) throw new Error('seed_type must be tracks or artists.');
  if (!Array.isArray(document.seeds) || document.seeds.some(s => typeof s !== 'string' || !s.trim() || s.length > 500))
    throw new Error('Provide 2–20 distinct seed strings.');
  const seeds = [...new Map(document.seeds.map(s => [s.trim().toLowerCase(), s.trim()])).values()];
  if (seeds.length < 2 || seeds.length > 20) throw new Error('Provide 2–20 distinct seed strings.');
  if (document.reference_tracks !== undefined && !Array.isArray(document.reference_tracks))
    throw new Error('reference_tracks must be an array.');
  const maxRequests = document.budget?.requests ?? 40;
  const seconds = document.budget?.seconds ?? 60;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100
      || !Number.isInteger(seconds) || seconds < 1 || seconds > 180)
    throw new Error('Budget requires 1–100 requests and 1–180 seconds.');
  const provider = options.provider ?? await import('./server.js');
  const deadline = Date.now() + seconds * 1000;
  let requests = 0;
  let budgetReached = false;
  let providerFailures = 0;
  let providerStopped = false;
  const result = await provider.discoverSoundcloudShelves(seeds, document.seed_type === 'tracks', async url => {
    const target = new URL(url);
    if (target.origin !== 'https://api.soundcloud.com') throw new Error('Unexpected provider endpoint.');
    if (providerStopped) throw new Error('Provider unavailable for this harvest.');
    if (requests >= maxRequests || Date.now() >= deadline) {
      budgetReached = true;
      throw new Error('Harvest budget reached.');
    }
    requests++;
    try {
      return await provider.soundcloudFetch(target, {
        signal: AbortSignal.timeout(Math.min(10000, Math.max(1, deadline - Date.now()))),
      });
    } catch (error) {
      providerFailures++;
      if ([401, 403, 429].includes(error.status)) providerStopped = true;
      throw new Error(`Provider read failed (${error.status || error.name || 'unknown'}).`);
    }
  });
  if (!result.shelves.length || !result.items.length)
    throw new Error(`No qualifying shelves harvested (${requests} requests; ${providerFailures} provider failures). Nothing saved or published.`);
  const snapshot = normalizeProviderSnapshot({ mode: 'discover', sources: result.report, items: result.items });
  const run = {
    kind: 'qrator-harvest', run_id: crypto.randomUUID(), created_at: new Date().toISOString(),
    brief, seeds, seed_type: document.seed_type, reference_tracks: document.reference_tracks ?? [], snapshot,
    harvest: { requests, qualified_shelves: result.shelves.length, profiles_scanned: result.profilesScanned,
      partial: budgetReached || result.errors.length > 0, budget_reached: budgetReached, provider_failures: providerFailures },
  };
  const directory = options.directory ?? defaultDirectory();
  await privateDirectory(directory);
  await saveExclusive(path.join(directory, `${run.run_id}.json`), { ...run, integrity: digest(run) });
  return run;
}

export async function validate(document, options = {}) {
  const run = await loadRun(options.directory ?? defaultDirectory(), document.run_id);
  if (!Array.isArray(document.items) || document.items.length > 500)
    throw new Error('Provide an ordered items array of at most 500 selections.');
  const candidates = new Map(run.snapshot.candidates.map(c => [c.recording_key, c]));
  const items = document.items.map(item => {
    const candidate = candidates.get(item?.recording_key);
    if (!candidate) throw new Error('Selection is outside the saved harvest snapshot.');
    if (item.candidate || item.evidence) throw new Error('Candidate identity and shelf evidence come only from the saved harvest.');
    return { candidate, rationale: item.rationale, traits: item.traits, evidence: candidate.sources };
  });
  const result = validateCurationProposal({ brief: run.brief, reference_tracks: run.reference_tracks, items });
  result.receipt.run_id = run.run_id;
  result.receipt.snapshot_id = run.snapshot.snapshot_id;
  result.receipt.harvest = run.harvest;
  return result;
}

export async function publish(document, options = {}) {
  const choice = document.publish;
  if (choice?.confirmed !== true || choice.provider !== 'soundcloud'
      || !['private', 'public'].includes(choice.visibility)
      || typeof choice.name !== 'string' || !choice.name.trim() || choice.name.length > 100)
    throw new Error('Publish requires confirmed=true, provider=soundcloud, name, and explicit private/public visibility.');
  const validated = await validate(document, options);
  if (!validated.accepted.length || validated.rejected.length)
    throw new Error('Resolve all validation rejections before publishing.');
  const directory = options.directory ?? defaultDirectory();
  const receiptPath = path.join(directory, `${document.run_id}.publication.json`);
  const requestHash = digest({ accepted: validated.accepted, choice });
  try {
    const prior = await readPrivate(receiptPath);
    if (prior.request_hash === requestHash && prior.state === 'published') return prior;
    throw new Error('Publication already attempted for this run; reconcile the receipt before any further write.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const provider = options.provider ?? await import('./server.js');
  const claim = { run_id: document.run_id, request_hash: requestHash, state: 'uncertain',
    attempted_at: new Date().toISOString(), validation: validated.receipt };
  await saveExclusive(receiptPath, claim);
  const result = await provider.publishSoundcloudCandidates({ name: choice.name.trim(),
    candidates: validated.accepted, isPublic: choice.visibility === 'public', requireAllResolved: true });
  const receipt = { ...claim, state: 'published', result };
  const temporary = `${receiptPath}.${crypto.randomUUID()}.tmp`;
  await saveExclusive(temporary, receipt);
  await rename(temporary, receiptPath);
  return receipt;
}

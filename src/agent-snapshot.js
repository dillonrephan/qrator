import crypto from 'node:crypto';

import { recordingKey } from './agent-curation.js';

const MAX_CANDIDATES = 5_000;

export function normalizeProviderSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A provider snapshot source must be an object.');
  }
  if (!Array.isArray(value.items)) {
    throw new TypeError('A provider snapshot source needs an items array.');
  }
  if (value.items.length > MAX_CANDIDATES) {
    throw new TypeError(`A provider snapshot may contain at most ${MAX_CANDIDATES} candidates.`);
  }

  const byKey = new Map();
  for (const raw of value.items) {
    const candidate = snapshotCandidate(raw);
    if (!candidate) continue;
    const existing = byKey.get(candidate.recording_key);
    if (!existing) {
      byKey.set(candidate.recording_key, candidate);
      continue;
    }
    existing.sources = [...new Set([...existing.sources, ...candidate.sources])];
    existing.shelf_confidence = Math.max(existing.shelf_confidence, candidate.shelf_confidence);
    existing.recording_confidence = Math.max(existing.recording_confidence, candidate.recording_confidence);
    existing.why ||= candidate.why;
  }

  const candidates = [...byKey.values()];
  if (!candidates.length) throw new TypeError('A provider snapshot needs at least one usable candidate.');
  const shelfCounts = new Map();
  for (const candidate of candidates) {
    for (const source of candidate.sources) shelfCounts.set(source, (shelfCounts.get(source) || 0) + 1);
  }

  const core = {
    schema_version: 1,
    kind: 'qrator-provider-snapshot',
    origin: {
      mode: text(value.mode, 80) || null,
      report: text(value.sources, 4_000) || null,
    },
    providers: providerNames(candidates),
    shelves: [...shelfCounts]
      .map(([label, candidate_count]) => ({ label, candidate_count }))
      .sort((a, b) => b.candidate_count - a.candidate_count || a.label.localeCompare(b.label)),
    candidate_count: candidates.length,
    candidates,
  };
  const snapshotId = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return { ...core, snapshot_id: `sha256:${snapshotId}` };
}

function snapshotCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = {
    artist: text(raw.artist, 300),
    title: text(raw.title, 500),
    album: text(raw.album, 500) || null,
    spotify_uri: /^spotify:track:[A-Za-z0-9]+$/.test(String(raw.spotify_uri || ''))
      ? raw.spotify_uri : null,
    soundcloud_urn: /^soundcloud:tracks:[A-Za-z0-9]+$/.test(String(raw.soundcloud_urn || ''))
      ? raw.soundcloud_urn : null,
    soundcloud_url: soundcloudUrl(raw.soundcloud_url),
    musicbrainz_id: /^[0-9a-f-]{36}$/i.test(String(raw.musicbrainz_id || ''))
      ? String(raw.musicbrainz_id).toLowerCase() : null,
  };
  const key = recordingKey(candidate);
  if (!candidate.artist || !candidate.title || !key) return null;
  return {
    recording_key: key,
    identity_strength: /^(soundcloud:tracks:|spotify:track:)/.test(key) ? 'provider' : 'metadata-fallback',
    ...candidate,
    shelf_confidence: percentage(raw.shelf_confidence),
    recording_confidence: percentage(raw.recording_confidence),
    discovery_distance: text(raw.discovery_distance, 80) || null,
    sources: Array.isArray(raw.sources)
      ? [...new Set(raw.sources.map((source) => text(source, 300)).filter(Boolean))].slice(0, 20)
      : [],
    why: text(raw.why, 1_000) || null,
  };
}

function providerNames(candidates) {
  const providers = new Set();
  for (const candidate of candidates) {
    if (candidate.soundcloud_urn || candidate.soundcloud_url) providers.add('soundcloud');
    if (candidate.spotify_uri) providers.add('spotify');
    if (candidate.musicbrainz_id) providers.add('musicbrainz');
    if (candidate.identity_strength === 'metadata-fallback') providers.add('metadata');
  }
  return [...providers].sort();
}

function soundcloudUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname.toLowerCase())) return null;
    return `https://soundcloud.com${url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

function percentage(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function text(value, limit) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

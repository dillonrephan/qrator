const MIN_LENGTH = 5;
const MAX_LENGTH = 475;
const MAX_TEXT = 2_000;

export function normalizeCurationBrief(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A curation brief must be an object.');
  }

  const objective = cleanText(value.objective, MAX_TEXT);
  if (!objective) throw new TypeError('A curation brief needs an objective.');

  const requestedLength = boundedInteger(value.requested_length, MIN_LENGTH, MAX_LENGTH, 40);
  const constraints = value.constraints && typeof value.constraints === 'object'
    ? value.constraints
    : {};
  const memory = value.memory && typeof value.memory === 'object' ? value.memory : {};
  const memoryMode = memory.mode || 'ephemeral';
  if (!['ephemeral', 'explicit-save'].includes(memoryMode)) {
    throw new TypeError('Curation memory must be ephemeral or explicit-save.');
  }
  const memoryLabel = cleanText(memory.label, 200);
  if (memoryMode === 'explicit-save' && !memoryLabel) {
    throw new TypeError('An explicitly saved recipe needs a human-readable label.');
  }

  return {
    version: 1,
    objective,
    requested_length: requestedLength,
    desired_traits: normalizedTerms(value.desired_traits),
    avoid_traits: normalizedTerms(value.avoid_traits),
    constraints: {
      exclude_reference_recordings: constraints.exclude_reference_recordings !== false,
      max_tracks_per_artist: boundedInteger(constraints.max_tracks_per_artist, 1, 50, 4),
      max_consecutive_by_artist: boundedInteger(constraints.max_consecutive_by_artist, 1, 10, 1),
      minimum_shelf_overlap: boundedInteger(constraints.minimum_shelf_overlap, 1, 20, 2),
    },
    memory: {
      mode: memoryMode,
      label: memoryMode === 'explicit-save' ? memoryLabel : null,
    },
    publish: {
      requested: false,
      target: null,
      visibility: null,
    },
  };
}

export function recordingKey(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const soundcloudUrn = cleanText(candidate.soundcloud_urn, 300);
  if (/^soundcloud:tracks:[A-Za-z0-9]+$/.test(soundcloudUrn)) return soundcloudUrn;

  const spotifyUri = cleanText(candidate.spotify_uri, 300);
  if (/^spotify:track:[A-Za-z0-9]+$/.test(spotifyUri)) return spotifyUri;

  const soundcloudUrl = canonicalSoundcloudUrl(candidate.soundcloud_url);
  if (soundcloudUrl) return `soundcloud-url:${soundcloudUrl}`;

  const artist = normalizedText(candidate.artist);
  const title = normalizedText(candidate.title);
  return artist && title ? `metadata:${artist}\n${title}` : null;
}

export function validateCurationProposal({ brief: rawBrief, reference_tracks: referenceTracks = [], items = [] }) {
  const brief = normalizeCurationBrief(rawBrief);
  if (!Array.isArray(referenceTracks) || !Array.isArray(items)) {
    throw new TypeError('Reference tracks and proposal items must be arrays.');
  }

  const referenceKeys = new Set(referenceTracks.map(recordingKey).filter(Boolean));
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  const artistCounts = new Map();
  const avoided = new Set(brief.avoid_traits);

  for (const [inputIndex, item] of items.entries()) {
    const candidate = item?.candidate && typeof item.candidate === 'object'
      ? item.candidate
      : item;
    const key = recordingKey(candidate);
    const artist = cleanText(candidate?.artist, 300);
    const title = cleanText(candidate?.title, 500);
    const rationale = cleanText(item?.rationale, MAX_TEXT);
    const traits = normalizedTerms(item?.traits);
    const evidence = normalizedEvidence(item?.evidence ?? candidate?.sources);
    const reasons = [];

    if (!key || !artist || !title) reasons.push('missing recording identity');
    if (!rationale) reasons.push('missing curator rationale');
    if (!evidence.length) reasons.push('missing shelf or curator evidence');
    if (key && seen.has(key)) reasons.push('duplicate recording');
    if (key && brief.constraints.exclude_reference_recordings && referenceKeys.has(key)) {
      reasons.push('present in excluded reference material');
    }
    const avoidedTraits = traits.filter((trait) => avoided.has(trait));
    if (avoidedTraits.length) reasons.push(`avoided traits: ${avoidedTraits.join(', ')}`);

    const artistKey = normalizedText(artist);
    const artistCount = artistCounts.get(artistKey) || 0;
    if (artistKey && artistCount >= brief.constraints.max_tracks_per_artist) {
      reasons.push('artist density cap reached');
    }

    const previousArtists = accepted
      .slice(-brief.constraints.max_consecutive_by_artist)
      .map((entry) => normalizedText(entry.artist));
    if (artistKey && previousArtists.length === brief.constraints.max_consecutive_by_artist
      && previousArtists.every((previous) => previous === artistKey)) {
      reasons.push('consecutive artist cap reached');
    }
    if (accepted.length >= brief.requested_length) reasons.push('requested length reached');

    if (reasons.length) {
      rejected.push({ input_index: inputIndex, key, artist, title, reasons });
      continue;
    }

    seen.add(key);
    const acceptedItem = {
      position: accepted.length + 1,
      key,
      artist,
      title,
      soundcloud_urn: cleanText(candidate.soundcloud_urn, 300) || null,
      soundcloud_url: canonicalSoundcloudUrl(candidate.soundcloud_url),
      spotify_uri: cleanText(candidate.spotify_uri, 300) || null,
      rationale,
      traits,
      evidence,
    };
    accepted.push(acceptedItem);
    artistCounts.set(artistKey, artistCount + 1);
  }

  return {
    brief,
    accepted,
    rejected,
    receipt: {
      version: 1,
      objective: brief.objective,
      requested_length: brief.requested_length,
      accepted_count: accepted.length,
      rejected_count: rejected.length,
      reference_recordings_seen: referenceKeys.size,
      reference_repeats_rejected: rejected.filter((item) => item.reasons.includes('present in excluded reference material')).length,
      unique_recordings: new Set(accepted.map((item) => item.key)).size,
      memory: brief.memory,
      publish: brief.publish,
    },
  };
}

function normalizedEvidence(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => {
    if (typeof entry === 'string') return cleanText(entry, 500);
    if (entry && typeof entry === 'object') return cleanText(entry.label || entry.source || entry.kind, 500);
    return '';
  }).filter(Boolean))];
}

function normalizedTerms(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => normalizedText(entry)).filter(Boolean))].slice(0, 100);
}

function canonicalSoundcloudUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname.toLowerCase())) return null;
    const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    return `https://soundcloud.com${pathname}`;
  } catch {
    return null;
  }
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizedText(value) {
  return cleanText(value, MAX_TEXT)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

import http from 'node:http';
import { readFile, writeFile, copyFile, chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const tokenPath = path.join(root, '.spotify-token.json');
const soundcloudTokenPath = path.join(root, '.soundcloud-token.json');
const stateDir = path.join(root, 'data');
const tasteProfilePath = path.join(stateDir, 'taste-profile.json');
const runFile = promisify(execFile);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TASTE_JUDGMENTS = 10_000;
const MAX_PLAYLIST_LENGTH = 475;
const MAX_SOUNDCLOUD_PLAYLIST_TRACKS = 500;
const RUN_TTL_MS = 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const SOUNDCLOUD_DISCOVERY_SEED_LIMIT = 20;
const SOUNDCLOUD_PLAYLIST_SEARCH_LIMIT = 20;
const SOUNDCLOUD_FAVORITER_PAGE_SIZE = 200;
const SOUNDCLOUD_FAVORITER_PAGE_LIMIT = 5;
const SOUNDCLOUD_QUALIFIED_CURATOR_LIMIT = 25;
const SOUNDCLOUD_USER_PLAYLIST_LIMIT = 10;
const SOUNDCLOUD_SHELF_TRACK_LIMIT = 100;

loadEnv(path.join(root, '.env'));

const config = {
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  lastfmApiKey: process.env.LASTFM_API_KEY,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8787/callback',
  port: Number(process.env.PORT || 8787),
  soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID,
  soundcloudClientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET,
  soundcloudRedirectUri: process.env.SOUNDCLOUD_REDIRECT_URI || 'http://127.0.0.1:8787/soundcloud/callback',
};

const scopes = [
  'playlist-modify-private',
  'playlist-modify-public',
  'playlist-read-private',
  'user-top-read',
  'user-read-private',
].join(' ');

const pendingStates = new Map();
const pendingSoundcloudStates = new Map();
const discoveryRuns = new Map();
let tasteProfileWrite = Promise.resolve();

export const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => respondWithError(res, error));
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`QRator running at http://127.0.0.1:${config.port}`);
    if (!config.clientId || !config.clientSecret) {
      console.log('Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env before connecting.');
    }
  });
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') return sendFile(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/styles.css') return sendFile(res, 'styles.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/login') return startLogin(res);
    if (req.method === 'GET' && url.pathname === '/callback') return handleCallback(url, res);
    if (req.method === 'GET' && url.pathname === '/soundcloud/login') return startSoundcloudLogin(res);
    if (req.method === 'GET' && url.pathname === '/soundcloud/callback') return handleSoundcloudCallback(url, res);
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, {
        configured: Boolean(config.clientId && config.clientSecret),
        authenticated: existsSync(tokenPath),
        lastfmConfigured: Boolean(config.lastfmApiKey),
        listenbrainzAvailable: true,
        soundcloudConfigured: Boolean(config.soundcloudClientId && config.soundcloudClientSecret),
        soundcloudAuthenticated: existsSync(soundcloudTokenPath),
        redirectUri: config.redirectUri,
        soundcloudRedirectUri: config.soundcloudRedirectUri,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') return spotifyProxy(res, 'https://api.spotify.com/v1/me');
    if (req.method === 'GET' && url.pathname === '/api/profile') {
      const judgments = await readTasteProfile();
      return json(res, 200, tasteProfileDocument(judgments));
    }
    if (req.method === 'PUT' && url.pathname === '/api/profile/judgments') {
      return recordTasteJudgment(req, res);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/profile/judgments/')) {
      return removeTasteJudgment(url, res);
    }
    if (req.method === 'DELETE' && url.pathname === '/api/profile') return eraseTasteProfile(res);
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim();
      if (!query) return json(res, 400, { error: 'Missing search query.' });
      const searchUrl = new URL('https://api.spotify.com/v1/search');
      searchUrl.searchParams.set('type', 'track');
      searchUrl.searchParams.set('limit', '8');
      searchUrl.searchParams.set('q', query);
      return spotifyProxy(res, searchUrl);
    }
    if (req.method === 'POST' && url.pathname === '/api/playlists') return createPlaylist(req, res);
    if (req.method === 'GET' && url.pathname === '/api/soundcloud/search') return soundcloudSearch(url, res);
    if (req.method === 'POST' && url.pathname === '/api/discover') return discover(req, res);
    if (req.method === 'POST' && url.pathname === '/api/discover/playback') return resolveDiscoveryPlayback(req, res);
    if (req.method === 'POST' && url.pathname === '/api/discover/playlist') return createDiscoveryPlaylist(req, res);
    if (req.method === 'POST' && url.pathname === '/api/discover/soundcloud-playlist') return createSoundcloudDiscoveryPlaylist(req, res);
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    return respondWithError(res, error);
  }
}

function respondWithError(res, error) {
  console.error(error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  return json(res, Number.isInteger(error.status) ? error.status : 500, {
    error: error.expose === false ? 'Unexpected error.' : error.message || 'Unexpected error.',
  });
}

function startSoundcloudLogin(res) {
  if (!config.soundcloudClientId || !config.soundcloudClientSecret) {
    return html(res, 500, page('Missing SoundCloud credentials', '<p>Add SoundCloud client credentials to <code>.env</code>, then restart QRator.</p>'));
  }
  pruneStates();
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pendingSoundcloudStates.set(state, { createdAt: Date.now(), verifier });
  const authUrl = new URL('https://secure.soundcloud.com/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.soundcloudClientId);
  authUrl.searchParams.set('redirect_uri', config.soundcloudRedirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function handleSoundcloudCallback(url, res) {
  const oauthError = url.searchParams.get('error');
  if (oauthError) return html(res, 400, page('SoundCloud denied access', `<p>${escapeHtml(oauthError)}</p>`));
  pruneStates();
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const pending = state ? pendingSoundcloudStates.get(state) : null;
  if (!pending || !code) return html(res, 400, page('Invalid callback', '<p>The SoundCloud authorization request expired or was invalid.</p>'));
  pendingSoundcloudStates.delete(state);
  const token = await requestSoundcloudToken({
    grant_type: 'authorization_code', code, redirect_uri: config.soundcloudRedirectUri, code_verifier: pending.verifier,
  });
  await saveSoundcloudToken(token);
  return html(res, 200, page('SoundCloud connected', '<p>Authorization is complete. QRator can now resolve and publish SoundCloud tracks.</p><p><a href="/">Return to QRator</a></p>'));
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function startLogin(res) {
  if (!config.clientId || !config.clientSecret) {
    return html(res, 500, page('Missing credentials', '<p>Create <code>.env</code> from <code>.env.example</code>, then restart QRator.</p>'));
  }
  pruneStates();
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now());
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('state', state);
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function handleCallback(url, res) {
  const oauthError = url.searchParams.get('error');
  if (oauthError) return html(res, 400, page('Spotify denied access', `<p>${escapeHtml(oauthError)}</p>`));
  pruneStates();
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !pendingStates.has(state) || !code) {
    return html(res, 400, page('Invalid callback', '<p>The authorization request expired or was invalid.</p>'));
  }
  pendingStates.delete(state);
  const token = await requestToken({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri });
  await saveToken(token);
  return html(res, 200, page('Spotify connected', '<p>Authorization is complete.</p><p><a href="/">Return to QRator</a></p>'));
}

async function createPlaylist(req, res) {
  const body = await readJson(req);
  const name = cleanText(body.name, 100);
  const description = cleanText(body.description, 300) || 'Created with QRator.';
  const uris = validSpotifyUris(body.uris);
  if (!name) return json(res, 400, { error: 'Playlist name is required.' });
  if (!uris.length) return json(res, 400, { error: 'Add at least one valid Spotify track.' });
  const playlist = await writePlaylist({ name, description, isPublic: Boolean(body.public), uris });
  return json(res, 201, playlist);
}

async function discover(req, res) {
  const body = await readJson(req);
  const input = cleanText(body.query, 50_000);
  const length = parseLength(body.length);
  if (!input) return json(res, 400, { error: 'Add a seed, a source URL, or pasted tracklist text.' });

  const parsed = parseDiscoveryInput(input);
  const mode = chooseDiscoveryMode(body.mode, input, parsed);
  if (parsed.seeds.length < 1 && parsed.urls.length === 0 && !parsed.text) {
    return json(res, 400, { error: 'Use a seed, a source URL, or pasted tracklist text.' });
  }
  if (mode === 'discover' && parsed.seeds.length < 2) {
    return json(res, 400, { error: 'Expanding a shortlist requires at least two distinct seed tracks or artists so a shelf can prove overlap.' });
  }
  if (parsed.seeds.length === 1 && parsed.urls.length === 0 && !parsed.text) {
    return json(res, 400, { error: 'Add at least two distinct tracks or artists. One shared song does not qualify a SoundCloud shelf.' });
  }

  const runDir = await mkdtemp(path.join(os.tmpdir(), 'qrator-run-'));
  try {
    if (existsSync(tokenPath)) {
      await getValidToken();
      const runTokenPath = path.join(runDir, '.spotify-token.json');
      await copyFile(tokenPath, runTokenPath);
      await chmod(runTokenPath, 0o600);
    }
    const pythonSourceUrls = [];
    const officialSoundcloudItems = [];
    let soundcloudShelfReport = null;
    if (parsed.seeds.length && existsSync(soundcloudTokenPath)) {
      try {
        const discovered = await discoverSoundcloudShelves(parsed.seeds, parsed.seedType === '--tracks');
        officialSoundcloudItems.push(...discovered.items);
        soundcloudShelfReport = discovered.report;
      } catch (error) {
        console.warn(`Official SoundCloud shelf discovery failed: ${error.message}`);
      }
    }
    for (const [index, sourceUrl] of parsed.urls.entries()) {
      if (safeExternalUrl(sourceUrl, 'soundcloud.com') && existsSync(soundcloudTokenPath)) {
        try {
          const tracks = await officialSoundcloudTracksFromUrl(sourceUrl);
          officialSoundcloudItems.push(...tracks.map((track) => soundcloudCandidateFromTrack(track, index + 1)));
        } catch (error) {
          console.warn(`Official SoundCloud source hydration failed; trying the bounded page reader: ${error.message}`);
        }
      }
      pythonSourceUrls.push(sourceUrl);
    }
    const dbPath = path.join(runDir, 'qrator.sqlite');
    const args = ['-m', 'music_harvester.main', '--db', dbPath, mode === 'discover' ? 'discover-from-seeds' : 'create-seeds'];
    if (parsed.seeds.length) args.push(parsed.seedType, ...parsed.seeds);
    if (mode === 'discover') args.push('--search-limit', '10');
    else {
      for (const sourceUrl of pythonSourceUrls) args.push('--source-url', sourceUrl);
      if (parsed.text) args.push('--text', parsed.text);
      if (body.thorough) args.push('--thorough');
      if (parsed.seeds.length) args.push('--search-limit', '10');
    }
    args.push('--length', String(length));
    const completed = await runPython(args, runDir);
    const outputDir = path.join(runDir, 'output');
    const [playlist, sources, unresolved, items] = await Promise.all([
      readOptional(path.join(outputDir, 'final_playlist.md')),
      readOptional(path.join(outputDir, 'bridge_sources.md')),
      readOptional(path.join(outputDir, 'unresolved_interesting.md')),
      readJsonFile(path.join(outputDir, 'final_playlist.json'), []),
    ]);
    const mergedItems = mergeHydratedCandidates([...officialSoundcloudItems, ...items]);
    if (!mergedItems.length) {
      console.warn(`Discovery produced no items. Command: python ${args.join(' ')}\n${completed.stdout}\n${completed.stderr}`);
      let message = 'Discovery completed but found no usable tracks. Try different seeds or a different source URL.';
      if (parsed.urls.some((url) => safeExternalUrl(url, 'soundcloud.com'))) {
        message = 'No tracks were available from that SoundCloud page. Official API hydration and the enabled bounded page reader both returned nothing.';
      } else if (parsed.seeds.length && !existsSync(soundcloudTokenPath)) {
        message = 'Connect SoundCloud to discover real public user likes and playlist shelves from track or artist seeds.';
      } else if (parsed.seeds.length) {
        message = 'SoundCloud found no usable public user likes or playlist shelves for those seeds. Try a more exact artist/track seed.';
      }
      const error = new Error(message);
      error.status = 422;
      throw error;
    }
    const judgments = await readTasteProfile();
    const rankedItems = diversifyAcrossShelves(rankCandidatesForTaste(mergedItems, judgments), length);
    const runId = crypto.randomUUID();
    pruneRuns();
    discoveryRuns.set(runId, { createdAt: Date.now(), items: rankedItems });
    return json(res, 200, {
      runId,
      playlist,
      sources: [soundcloudShelfReport, sources].filter(Boolean).join('\n\n'),
      unresolved,
      log: completed.stdout,
      seeds: playlistSeeds(rankedItems),
      resolved: rankedItems.filter((item) => item.spotify_uri).length,
      total: rankedItems.length,
      items: rankedItems.map(publicCandidate),
      profileJudgments: judgments.length,
      mode,
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

async function officialSoundcloudTracksFromUrl(sourceUrl, limit = 100) {
  const safeUrl = safeExternalUrl(sourceUrl, 'soundcloud.com');
  if (!safeUrl) throw new Error('Official SoundCloud hydration requires a public HTTPS SoundCloud URL.');
  const source = new URL(safeUrl);
  const sourcePath = source.pathname.replace(/\/+$/, '').toLowerCase();
  const resolveTarget = new URL(safeUrl);
  if (sourcePath.endsWith('/likes')) resolveTarget.pathname = resolveTarget.pathname.replace(/\/likes\/?$/i, '');
  const resolveUrl = new URL('https://api.soundcloud.com/resolve');
  resolveUrl.searchParams.set('url', resolveTarget.toString());
  const resolved = await soundcloudFetch(resolveUrl);
  if (resolved?.kind === 'track') return [resolved];
  if (resolved?.kind === 'playlist' || resolved?.kind === 'system-playlist') {
    return soundcloudTrackCollection(resolved.tracks, limit);
  }
  if (resolved?.kind === 'user' && /^soundcloud:users:[A-Za-z0-9]+$/.test(String(resolved.urn || ''))) {
    const collection = sourcePath.endsWith('/likes') ? 'likes/tracks' : 'tracks';
    const tracksUrl = new URL(`https://api.soundcloud.com/users/${encodeURIComponent(resolved.urn)}/${collection}`);
    tracksUrl.searchParams.set('limit', String(limit));
    tracksUrl.searchParams.set('linked_partitioning', 'true');
    const page = await soundcloudFetch(tracksUrl);
    return soundcloudTrackCollection(Array.isArray(page) ? page : page?.collection, limit);
  }
  return [];
}

export async function discoverSoundcloudShelves(seedValues, trackSeeds, fetcher = soundcloudFetch) {
  const seenSeeds = new Set();
  const seeds = seedValues
    .map((value) => soundcloudSeed(value, trackSeeds))
    .filter((seed) => {
      const key = normalizedMatchText(seed.value);
      if (!key || seenSeeds.has(key)) return false;
      seenSeeds.add(key);
      return true;
    })
    .slice(0, SOUNDCLOUD_DISCOVERY_SEED_LIMIT);
  const items = [];
  const shelves = new Set();
  const errors = [];
  const playlistCandidates = new Map();
  const curatorOverlaps = new Map();
  const profilePlaylistEvidence = new Map();

  for (const [seedIndex, seed] of seeds.entries()) {
    const playlistSearch = new URL('https://api.soundcloud.com/playlists');
    playlistSearch.searchParams.set('q', seed.value);
    playlistSearch.searchParams.set('show_tracks', 'true');
    playlistSearch.searchParams.set('limit', String(SOUNDCLOUD_PLAYLIST_SEARCH_LIMIT));
    playlistSearch.searchParams.set('linked_partitioning', 'true');
    try {
      const page = await fetcher(playlistSearch);
      for (const playlist of soundcloudCollection(page).slice(0, SOUNDCLOUD_PLAYLIST_SEARCH_LIMIT)) {
        const urn = String(playlist?.urn || '');
        if (/^soundcloud:playlists:[A-Za-z0-9]+$/.test(urn)) playlistCandidates.set(urn, playlist);
      }
    } catch (error) {
      errors.push(`playlist search for ${seed.value}: ${error.message}`);
    }

    const trackSearch = new URL('https://api.soundcloud.com/tracks');
    trackSearch.searchParams.set('q', seed.value);
    trackSearch.searchParams.set('access', 'playable,preview');
    trackSearch.searchParams.set('limit', '12');
    trackSearch.searchParams.set('linked_partitioning', 'true');
    let anchor = null;
    try {
      const page = await fetcher(trackSearch);
      anchor = soundcloudCollection(page).find((track) => soundcloudTrackMatchesSeed(track, seed)) || null;
    } catch (error) {
      errors.push(`track search for ${seed.value}: ${error.message}`);
    }
    if (!anchor?.urn) continue;

    const curators = [];
    for (let pageIndex = 0; pageIndex < SOUNDCLOUD_FAVORITER_PAGE_LIMIT; pageIndex += 1) {
      const favoritersUrl = new URL(`https://api.soundcloud.com/tracks/${encodeURIComponent(anchor.urn)}/favoriters`);
      favoritersUrl.searchParams.set('limit', String(SOUNDCLOUD_FAVORITER_PAGE_SIZE));
      favoritersUrl.searchParams.set('offset', String(pageIndex * SOUNDCLOUD_FAVORITER_PAGE_SIZE));
      try {
        const page = soundcloudCollection(await fetcher(favoritersUrl)).slice(0, SOUNDCLOUD_FAVORITER_PAGE_SIZE);
        curators.push(...page);
        if (page.length < SOUNDCLOUD_FAVORITER_PAGE_SIZE) break;
      } catch (error) {
        errors.push(`likers page ${pageIndex + 1} for ${seed.value}: ${error.message}`);
        break;
      }
    }

    for (const curator of curators) {
      const urn = String(curator?.urn || '');
      if (!/^soundcloud:users:[A-Za-z0-9]+$/.test(urn)) continue;
      const overlap = curatorOverlaps.get(urn) || { curator, seedIndexes: new Set() };
      overlap.seedIndexes.add(seedIndex);
      curatorOverlaps.set(urn, overlap);
    }
  }

  for (const playlist of playlistCandidates.values()) {
    try {
      const tracks = await soundcloudPlaylistTracks(playlist, fetcher);
      const hitIndexes = soundcloudShelfSeedHits(tracks, seeds);
      if (hitIndexes.size >= 2) {
        await addSoundcloudPlaylistShelf({ playlist, tracks, seeds, fetcher, items, shelves });
      }
      if (hitIndexes.size) {
        const owner = cleanText(playlist.user?.username, 200) || 'SoundCloud user';
        const ownerKey = cleanText(playlist.user?.urn || playlist.user?.permalink_url, 300) || normalizedMatchText(owner);
        const profile = profilePlaylistEvidence.get(ownerKey) || { owner, playlists: [], hitIndexes: new Set() };
        profile.playlists.push({ playlist, tracks });
        for (const index of hitIndexes) profile.hitIndexes.add(index);
        profilePlaylistEvidence.set(ownerKey, profile);
      }
    } catch (error) {
      errors.push(`searched playlist ${cleanText(playlist?.title, 200) || playlist?.urn}: ${error.message}`);
    }
  }

  for (const profile of profilePlaylistEvidence.values()) {
    if (profile.hitIndexes.size < 2 || profile.playlists.length < 2) continue;
    const source = `SoundCloud profile playlists · ${profile.owner}`;
    addSoundcloudTrackShelf({
      tracks: profile.playlists.flatMap((entry) => entry.tracks),
      seeds,
      items,
      shelves,
      source,
      why: `${profile.owner} placed ${profile.hitIndexes.size} distinct shortlist tracks across ${profile.playlists.length} hand-made SoundCloud playlists.`,
      confidence: Math.min(95, 88 + ((profile.hitIndexes.size - 2) * 3)),
    });
  }

  const qualifiedCurators = [...curatorOverlaps.values()]
    .filter((entry) => entry.seedIndexes.size >= 2)
    .sort((a, b) => b.seedIndexes.size - a.seedIndexes.size)
    .slice(0, SOUNDCLOUD_QUALIFIED_CURATOR_LIMIT);
  for (const { curator, seedIndexes } of qualifiedCurators) {
    const urn = String(curator.urn);
    const username = cleanText(curator.username || curator.permalink, 200) || 'SoundCloud listener';
    const hitCount = seedIndexes.size;
    const likesUrl = new URL(`https://api.soundcloud.com/users/${encodeURIComponent(urn)}/likes/tracks`);
    likesUrl.searchParams.set('access', 'playable,preview');
    likesUrl.searchParams.set('limit', String(SOUNDCLOUD_SHELF_TRACK_LIMIT));
    likesUrl.searchParams.set('linked_partitioning', 'true');
    try {
      const likedTracks = soundcloudTrackCollection(soundcloudCollection(await fetcher(likesUrl)), SOUNDCLOUD_SHELF_TRACK_LIMIT);
      addSoundcloudTrackShelf({
        tracks: likedTracks,
        seeds,
        items,
        shelves,
        source: `SoundCloud likes · ${username}`,
        why: `${username} liked ${hitCount} distinct tracks from the ${seeds.length}-track shortlist.`,
        confidence: Math.min(96, 86 + ((hitCount - 2) * 4)),
      });
    } catch (error) {
      errors.push(`likes for ${username}: ${error.message}`);
    }

    const playlistsUrl = new URL(`https://api.soundcloud.com/users/${encodeURIComponent(urn)}/playlists`);
    playlistsUrl.searchParams.set('show_tracks', 'true');
    playlistsUrl.searchParams.set('limit', String(SOUNDCLOUD_USER_PLAYLIST_LIMIT));
    playlistsUrl.searchParams.set('linked_partitioning', 'true');
    try {
      const playlistPage = await fetcher(playlistsUrl);
      for (const playlist of soundcloudCollection(playlistPage).slice(0, SOUNDCLOUD_USER_PLAYLIST_LIMIT)) {
        await addSoundcloudPlaylistShelf({
          playlist, seeds, fetcher, items, shelves,
        });
      }
    } catch (error) {
      errors.push(`playlists for ${username}: ${error.message}`);
    }
  }

  const report = shelves.size
    ? `SoundCloud shelf discovery: scanned ${curatorOverlaps.size} profiles and qualified ${shelves.size} public user likes/playlist ${shelves.size === 1 ? 'shelf' : 'shelves'} with at least two distinct hits from the ${seeds.length}-track shortlist. Algorithmic radios were not used.`
    : `SoundCloud shelf discovery scanned ${curatorOverlaps.size} profiles but found no public user likes or playlists with at least two distinct hits from the ${seeds.length}-track shortlist. One shared track is not treated as shelf evidence.`;
  if (errors.length) console.warn(`SoundCloud shelf discovery partial failures: ${errors.join('; ')}`);
  return { items, shelves: [...shelves], profilesScanned: curatorOverlaps.size, errors, report };
}

async function soundcloudPlaylistTracks(playlist, fetcher) {
  const urn = String(playlist?.urn || '');
  if (!/^soundcloud:playlists:[A-Za-z0-9]+$/.test(urn)) return [];
  let tracks = soundcloudTrackCollection(playlist.tracks, SOUNDCLOUD_SHELF_TRACK_LIMIT);
  if (!tracks.length) {
    const tracksUrl = new URL(`https://api.soundcloud.com/playlists/${encodeURIComponent(urn)}/tracks`);
    tracksUrl.searchParams.set('linked_partitioning', 'true');
    tracks = soundcloudTrackCollection(soundcloudCollection(await fetcher(tracksUrl)), SOUNDCLOUD_SHELF_TRACK_LIMIT);
  }
  return tracks;
}

async function addSoundcloudPlaylistShelf({ playlist, tracks: suppliedTracks, seeds, fetcher, items, shelves }) {
  const tracks = suppliedTracks || await soundcloudPlaylistTracks(playlist, fetcher);
  if (!tracks.length) return;
  const hitCount = soundcloudShelfSeedHits(tracks, seeds).size;
  if (hitCount < 2) return;
  const title = cleanText(playlist.title, 300) || 'Untitled playlist';
  const owner = cleanText(playlist.user?.username, 200) || 'SoundCloud user';
  addSoundcloudTrackShelf({
    tracks,
    seeds,
    items,
    shelves,
    source: `SoundCloud playlist · ${title} · ${owner}`,
    why: `${owner}'s hand-made SoundCloud playlist “${title}” contains ${hitCount} distinct tracks from the ${seeds.length}-track shortlist.`,
    confidence: Math.min(98, 90 + ((hitCount - 2) * 3)),
  });
}

function addSoundcloudTrackShelf({ tracks, seeds, items, shelves, source, why, confidence }) {
  let added = 0;
  for (const track of tracks) {
    if (seeds.some((seed) => soundcloudTrackIsSeed(track, seed))) continue;
    try {
      const candidate = soundcloudCandidateFromTrack(track);
      candidate.sources = [source];
      candidate.shelf_confidence = confidence;
      candidate.discovery_distance = 'one SoundCloud shelf hop';
      candidate.why = why;
      items.push(candidate);
      added += 1;
    } catch { /* Ignore malformed or non-public tracks inside otherwise usable shelves. */ }
  }
  if (added) shelves.add(source);
}

function soundcloudSeed(value, trackSeed) {
  const cleaned = cleanText(value, 500);
  if (!trackSeed) return { value: cleaned, artist: cleaned, title: '', trackSeed: false };
  const parts = cleaned.split(/\s+[-–—]\s+/, 2);
  return parts.length === 2
    ? { value: cleaned, artist: parts[0], title: parts[1], trackSeed: true }
    : { value: cleaned, artist: '', title: cleaned, trackSeed: true };
}

function soundcloudTrackIdentity(track) {
  const publisher = track?.publisher_metadata && typeof track.publisher_metadata === 'object' ? track.publisher_metadata : {};
  const artist = cleanText(track?.metadata_artist || publisher.artist || track?.user?.username, 300);
  let title = cleanText(publisher.release_title || track?.title, 500);
  const prefix = `${artist} - `;
  if (artist && title.toLowerCase().startsWith(prefix.toLowerCase())) title = title.slice(prefix.length).trim();
  return { artist, title };
}

function soundcloudTrackMatchesSeed(track, seed) {
  const identity = soundcloudTrackIdentity(track);
  if (!seed.trackSeed) {
    const wanted = normalizedMatchText(seed.artist);
    const actual = normalizedMatchText(identity.artist);
    return Boolean(wanted && actual && (actual === wanted || actual.includes(wanted) || wanted.includes(actual)));
  }
  if (seed.artist) return isStrictSoundcloudMatch({ artist: seed.artist, title: seed.title }, track);
  return titleVariants(identity.title, identity.artist).has(normalizedMatchText(seed.title));
}

function soundcloudTrackIsSeed(track, seed) {
  return seed.trackSeed && soundcloudTrackMatchesSeed(track, seed);
}

function soundcloudShelfSeedHits(tracks, seeds) {
  const hits = new Set();
  for (const [index, seed] of seeds.entries()) {
    if (tracks.some((track) => soundcloudTrackMatchesSeed(track, seed))) hits.add(index);
  }
  return hits;
}

function soundcloudCollection(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.collection) ? value.collection : [];
}

function soundcloudTrackCollection(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item?.track || item)
    .filter((track) => track?.kind === 'track' && track.access !== 'blocked')
    .slice(0, limit);
}

export function soundcloudCandidateFromTrack(track, sourceIndex = 1) {
  const publisher = track?.publisher_metadata && typeof track.publisher_metadata === 'object' ? track.publisher_metadata : {};
  const artist = cleanText(track?.metadata_artist || publisher.artist || track?.user?.username, 300);
  let title = cleanText(publisher.release_title || track?.title, 500);
  const prefix = `${artist} - `;
  if (artist && title.toLowerCase().startsWith(prefix.toLowerCase())) title = title.slice(prefix.length).trim();
  const soundcloudUrl = safeExternalUrl(track?.permalink_url, 'soundcloud.com');
  const soundcloudUrn = /^soundcloud:tracks:[A-Za-z0-9]+$/.test(String(track?.urn || '')) ? track.urn : null;
  if (!artist || !title || !soundcloudUrl || !soundcloudUrn) throw new Error('Official SoundCloud track metadata was incomplete.');
  return {
    artist,
    title,
    album: cleanText(publisher.album_title, 500) || null,
    spotify_uri: null,
    soundcloud_urn: soundcloudUrn,
    soundcloud_url: soundcloudUrl,
    musicbrainz_id: null,
    shelf_confidence: 85,
    recording_confidence: 90,
    discovery_distance: 'directly supplied',
    sources: [`soundcloud_official_${sourceIndex}`],
    why: 'Shown because it came directly from the explicitly supplied SoundCloud source through the official API.',
  };
}

export function mergeHydratedCandidates(items) {
  const merged = new Map();
  for (const item of items) {
    const artist = cleanText(item.artist, 300);
    const title = cleanText(item.title, 500);
    if (!artist || !title) continue;
    const key = `${normalizedMatchText(artist)}\n${normalizedMatchText(title)}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item, sources: Array.isArray(item.sources) ? [...item.sources] : [] });
      continue;
    }
    existing.album ||= item.album || null;
    existing.spotify_uri ||= item.spotify_uri || null;
    existing.soundcloud_urn ||= item.soundcloud_urn || null;
    existing.soundcloud_url ||= item.soundcloud_url || null;
    existing.musicbrainz_id ||= item.musicbrainz_id || null;
    existing.shelf_confidence = Math.max(Number(existing.shelf_confidence) || 0, Number(item.shelf_confidence) || 0);
    existing.recording_confidence = Math.max(Number(existing.recording_confidence) || 0, Number(item.recording_confidence) || 0);
    existing.sources = [...new Set([...(existing.sources || []), ...(item.sources || [])])];
    if (existing.sources.length > 1) {
      existing.why = `Shown because ${existing.sources.length} independent sources exposed the same recording.`;
    }
  }
  return [...merged.values()];
}

export function chooseDiscoveryMode(requestedMode, input, parsed = parseDiscoveryInput(input)) {
  if (requestedMode === 'discover' || requestedMode === 'distill') return requestedMode;
  const nonUrlLines = String(input || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^https?:\/\//i.test(line));
  return parsed.urls.length === 0 && parsed.seeds.length >= 2 && nonUrlLines.length <= SOUNDCLOUD_DISCOVERY_SEED_LIMIT
    ? 'discover'
    : 'distill';
}

async function createDiscoveryPlaylist(req, res) {
  const body = await readJson(req);
  pruneRuns();
  const runId = String(body.runId || '');
  const run = discoveryRuns.get(runId);
  if (!run) return json(res, 410, { error: 'This discovery run expired. Run discovery again before publishing.' });
  const selectedItems = selectRunItems(run.items, body.archiveIds);
  const uris = validSpotifyUris(selectedItems.map((item) => item.spotify_uri));
  if (!uris.length) return json(res, 400, { error: 'This run has no Spotify-resolved tracks.' });
  const name = cleanText(body.name, 100) || `QRator discovery ${new Date().toISOString().slice(0, 10)}`;
  const playlist = await writePlaylist({
    name,
    description: 'Discovered and reviewed with QRator.',
    isPublic: Boolean(body.public),
    uris,
  });
  return json(res, 201, { playlist, added: uris.length, unresolved: selectedItems.length - uris.length });
}

async function resolveDiscoveryPlayback(req, res) {
  const body = await readJson(req);
  pruneRuns();
  const run = discoveryRuns.get(String(body.runId || ''));
  if (!run) return json(res, 410, { error: 'This discovery run expired. Run discovery again before playing tracks.' });
  const archiveId = cleanText(body.archiveId, 200);
  const candidate = run.items.find((item) => candidateArchiveId(item) === archiveId);
  if (!candidate) return json(res, 404, { error: 'That candidate does not belong to this discovery run.' });

  let playback = playbackChoice(candidate);
  let soundcloudAttempted = false;
  if (playback?.provider !== 'soundcloud' && existsSync(soundcloudTokenPath)) {
    soundcloudAttempted = true;
    try {
      playback = playbackChoice(candidate, await resolveSoundcloudCandidate(candidate));
    } catch (error) {
      console.warn(`SoundCloud playback resolution failed; using fallback: ${error.message}`);
    }
  }
  if (!playback) {
    return json(res, 422, {
      error: soundcloudAttempted
        ? 'No strict playable SoundCloud match or Spotify fallback was available.'
        : 'No known playable source. Connect SoundCloud to try strict resolution.',
    });
  }
  return json(res, 200, { ...playback, soundcloudAttempted });
}

export function playbackChoice(candidate, resolvedSoundcloudTrack = null) {
  const directSoundcloudUrl = safeExternalUrl(candidate?.soundcloud_url, 'soundcloud.com');
  if (directSoundcloudUrl) {
    return { provider: 'soundcloud', url: directSoundcloudUrl, resolution: 'candidate' };
  }
  const resolvedSoundcloudUrl = safeExternalUrl(resolvedSoundcloudTrack?.permalink_url, 'soundcloud.com');
  if (resolvedSoundcloudUrl && isStrictSoundcloudMatch(candidate, resolvedSoundcloudTrack)) {
    return { provider: 'soundcloud', url: resolvedSoundcloudUrl, resolution: 'strict-search' };
  }
  const spotifyUri = String(candidate?.spotify_uri || '');
  if (/^spotify:track:[A-Za-z0-9]+$/.test(spotifyUri)) {
    return {
      provider: 'spotify',
      url: `https://open.spotify.com/track/${spotifyUri.split(':').at(-1)}`,
      resolution: 'fallback',
    };
  }
  return null;
}

async function soundcloudSearch(url, res) {
  const query = cleanText(url.searchParams.get('q'), 500);
  if (!query) return json(res, 400, { error: 'Missing SoundCloud search query.' });
  const searchUrl = new URL('https://api.soundcloud.com/tracks');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('limit', '10');
  searchUrl.searchParams.set('access', 'playable,preview');
  const data = await soundcloudFetch(searchUrl);
  const tracks = Array.isArray(data) ? data : data.collection || [];
  return json(res, 200, { tracks: tracks.map(publicSoundcloudTrack).filter(Boolean) });
}

async function createSoundcloudDiscoveryPlaylist(req, res) {
  const body = await readJson(req);
  pruneRuns();
  const run = discoveryRuns.get(String(body.runId || ''));
  if (!run) return json(res, 410, { error: 'This discovery run expired. Run discovery again before publishing.' });
  const selectedItems = selectRunItems(run.items, body.archiveIds);
  const name = cleanText(body.name, 100) || `QRator discovery ${new Date().toISOString().slice(0, 10)}`;
  const result = await publishSoundcloudCandidates({ name, candidates: selectedItems, isPublic: Boolean(body.public) });
  return json(res, 201, result);
}

export async function publishSoundcloudCandidates({ name, candidates, isPublic = false }) {
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_SOUNDCLOUD_PLAYLIST_TRACKS) {
    const error = new Error(`SoundCloud publishing requires one to ${MAX_SOUNDCLOUD_PLAYLIST_TRACKS} reviewed candidates.`);
    error.status = 400;
    throw error;
  }
  const resolved = [];
  const unresolved = [];
  for (const candidate of candidates) {
    const track = await resolveSoundcloudCandidate(candidate);
    if (track) resolved.push(track);
    else unresolved.push({ artist: cleanText(candidate.artist, 300), title: cleanText(candidate.title, 500) });
  }
  if (!resolved.length) {
    const error = new Error('QRator could not strictly resolve any selected tracks on SoundCloud. Nothing was created.');
    error.status = 422;
    error.unresolved = unresolved;
    throw error;
  }
  const playlist = await createSoundcloudPlaylist({
    name,
    description: 'Discovered and reviewed with QRator.',
    sharing: isPublic ? 'public' : 'private',
    trackUrns: resolved.map((track) => track.urn),
  });
  return {
    playlist: publicSoundcloudPlaylist(playlist),
    added: resolved.length,
    unresolved: unresolved.length,
    unresolvedTracks: unresolved,
  };
}

async function recordTasteJudgment(req, res) {
  const body = await readJson(req);
  pruneRuns();
  const run = discoveryRuns.get(String(body.runId || ''));
  if (!run) return json(res, 410, { error: 'This discovery run expired. Run discovery again before teaching the profile.' });
  const archiveId = cleanText(body.archiveId, 200);
  const preference = body.preference === 'keep' || body.preference === 'skip' ? body.preference : null;
  if (!preference) return json(res, 400, { error: 'Taste preference must be keep or skip.' });
  const candidate = run.items.find((item) => candidateArchiveId(item) === archiveId);
  if (!candidate) return json(res, 404, { error: 'That candidate does not belong to this discovery run.' });

  const result = await queueTasteProfileWrite(async () => {
    const judgments = await readTasteProfile();
    const existingIndex = judgments.findIndex((item) => item.archive_id === archiveId);
    const judgment = tasteJudgmentSnapshot(candidate, preference, existingIndex >= 0 ? judgments[existingIndex].created_at : undefined);
    if (existingIndex >= 0) judgments.splice(existingIndex, 1);
    else if (judgments.length >= MAX_TASTE_JUDGMENTS) {
      const error = new Error(`The taste profile is limited to ${MAX_TASTE_JUDGMENTS} explicit judgments.`);
      error.status = 409;
      throw error;
    }
    judgments.unshift(judgment);
    await writeTasteProfile(tasteProfilePath, judgments);
    return { judgment, judgments };
  });
  return json(res, 200, { judgment: result.judgment, profile: tasteProfileDocument(result.judgments) });
}

async function removeTasteJudgment(url, res) {
  const archiveId = decodeURIComponent(url.pathname.slice('/api/profile/judgments/'.length));
  if (!archiveId || archiveId.length > 200) return json(res, 400, { error: 'Invalid taste judgment identifier.' });
  const result = await queueTasteProfileWrite(async () => {
    const judgments = await readTasteProfile();
    const remaining = judgments.filter((item) => item.archive_id !== archiveId);
    if (remaining.length === judgments.length) return null;
    await writeTasteProfile(tasteProfilePath, remaining);
    return remaining;
  });
  return result ? json(res, 200, tasteProfileDocument(result)) : json(res, 404, { error: 'Taste judgment not found.' });
}

async function eraseTasteProfile(res) {
  const judgments = await queueTasteProfileWrite(async () => {
    await writeTasteProfile(tasteProfilePath, []);
    return [];
  });
  return json(res, 200, tasteProfileDocument(judgments));
}

async function writePlaylist({ name, description, isPublic, uris }) {
  const playlist = await spotifyFetch('https://api.spotify.com/v1/me/playlists', {
    method: 'POST', body: JSON.stringify({ name, description, public: isPublic }),
  });
  for (let i = 0; i < uris.length; i += 100) {
    await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
      method: 'POST', body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
  return playlist;
}

export function parseDiscoveryInput(input) {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const urls = [];
  const seeds = [];
  const textLines = [];
  for (const line of lines) {
    if (/^https?:\/\//i.test(line)) urls.push(line);
    else {
      textLines.push(line);
      if (looksLikeTrack(line)) seeds.push(line);
    }
  }
  if (seeds.length >= 1) return { seedType: '--tracks', seeds: seeds.slice(0, SOUNDCLOUD_DISCOVERY_SEED_LIMIT), urls, text: textLines.join('\n') };
  const artistSeeds = lines
    .filter((line) => !/^https?:\/\//i.test(line))
    .flatMap((line) => line.split(/\s+[+&]\s+|,\s*/))
    .map((line) => line.trim()).filter(Boolean);
  return { seedType: '--artists', seeds: artistSeeds.slice(0, SOUNDCLOUD_DISCOVERY_SEED_LIMIT), urls, text: textLines.join('\n') };
}

export function parseLength(value) {
  const length = Number(value ?? 30);
  if (!Number.isInteger(length) || length < 5 || length > MAX_PLAYLIST_LENGTH) {
    const error = new Error(`Playlist length must be a whole number from 5 to ${MAX_PLAYLIST_LENGTH}.`);
    error.status = 400;
    throw error;
  }
  return length;
}

export function selectRunItems(items, archiveIds) {
  if (archiveIds === undefined || archiveIds === null) return items;
  if (!Array.isArray(archiveIds) || archiveIds.length > MAX_PLAYLIST_LENGTH) {
    const error = new Error(`Current mix selection must be a list of at most ${MAX_PLAYLIST_LENGTH} candidates.`);
    error.status = 400;
    throw error;
  }
  const byId = new Map(items.map((item) => [candidateArchiveId(item), item]));
  const selected = [];
  const seen = new Set();
  for (const rawId of archiveIds) {
    const archiveId = cleanText(rawId, 200);
    if (!archiveId || !byId.has(archiveId)) {
      const error = new Error('Current mix selection contains a candidate outside this discovery run.');
      error.status = 400;
      throw error;
    }
    if (!seen.has(archiveId)) {
      selected.push(byId.get(archiveId));
      seen.add(archiveId);
    }
  }
  if (!selected.length) {
    const error = new Error('Keep at least one track in the current mix before publishing.');
    error.status = 400;
    throw error;
  }
  return selected;
}

function looksLikeTrack(line) { return /\s[-–—:]\s/.test(line) || /\sby\s/i.test(line); }
function cleanText(value, max) { return String(value || '').trim().slice(0, max); }
function validSpotifyUris(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(String(uri))))];
}

function normalizedMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(feat(?:uring)?|ft)\.?\b.*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleVariants(title, artist) {
  const normalizedTitle = normalizedMatchText(title);
  const normalizedArtist = normalizedMatchText(artist);
  return new Set([
    normalizedTitle,
    normalizedTitle.replace(new RegExp(`^${escapeRegex(normalizedArtist)}\\s+`), '').trim(),
  ].filter(Boolean));
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function isStrictSoundcloudMatch(candidate, track) {
  const targetArtist = normalizedMatchText(candidate.artist);
  const targetTitles = titleVariants(candidate.title, candidate.artist);
  const resultArtist = normalizedMatchText(track.metadata_artist || track.user?.username || '');
  const resultTitle = normalizedMatchText(track.title);
  if (!targetArtist || !targetTitles.size || !resultTitle) return false;
  const titleMatches = [...targetTitles].some((title) => resultTitle === title || resultTitle === `${targetArtist} ${title}`);
  if (!titleMatches) return false;
  if (resultArtist === targetArtist || resultTitle.startsWith(`${targetArtist} `)) return true;
  return resultArtist.includes(targetArtist) || targetArtist.includes(resultArtist);
}

export async function resolveSoundcloudCandidate(candidate) {
  const directUrl = safeExternalUrl(candidate?.soundcloud_url, 'soundcloud.com');
  if (directUrl) {
    const resolveUrl = new URL('https://api.soundcloud.com/resolve');
    resolveUrl.searchParams.set('url', directUrl);
    const resolved = await soundcloudFetch(resolveUrl);
    if (resolved?.kind === 'track' && typeof resolved.urn === 'string' && isStrictSoundcloudMatch(candidate, resolved)) {
      return resolved;
    }
  }
  const query = cleanText(`${candidate.artist} ${candidate.title}`, 500);
  if (!query) return null;
  const searchUrl = new URL('https://api.soundcloud.com/tracks');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('limit', '25');
  searchUrl.searchParams.set('access', 'playable,preview');
  const data = await soundcloudFetch(searchUrl);
  const tracks = Array.isArray(data) ? data : data.collection || [];
  return tracks.find((track) => typeof track?.urn === 'string' && isStrictSoundcloudMatch(candidate, track)) || null;
}

function publicSoundcloudTrack(track) {
  if (!track || typeof track.urn !== 'string' || !safeExternalUrl(track.permalink_url, 'soundcloud.com')) return null;
  return {
    urn: track.urn,
    title: cleanText(track.title, 500),
    artist: cleanText(track.metadata_artist || track.user?.username, 300),
    permalink_url: safeExternalUrl(track.permalink_url, 'soundcloud.com'),
    duration: Number(track.duration) || null,
  };
}

function publicSoundcloudPlaylist(playlist) {
  const permalinkUrl = safeExternalUrl(playlist?.permalink_url, 'soundcloud.com');
  if (!permalinkUrl) throw new Error('SoundCloud created a playlist without a safe public URL.');
  return { urn: cleanText(playlist.urn, 200), permalink_url: permalinkUrl, sharing: playlist.sharing === 'public' ? 'public' : 'private' };
}

async function runPython(args, cwd) {
  try {
    return await runFile('python', args, {
      cwd,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        QRATOR_STATE_DIR: stateDir,
        QRATOR_RUN_DEADLINE_UNIX: String(Date.now() / 1000 + 175),
      },
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    const wrapped = new Error(detail || 'Discovery command failed.');
    wrapped.expose = true;
    throw wrapped;
  }
}

async function readOptional(filePath) { try { return await readFile(filePath, 'utf8'); } catch { return ''; } }
async function readJsonFile(filePath, fallback) { try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return fallback; } }
function playlistSeeds(items) {
  return Array.isArray(items) ? items.map((item) => `${item.artist} - ${item.title}`.trim()).filter((item) => item && !item.startsWith(' - ')).slice(0, 12) : [];
}
function publicCandidate(item) {
  return {
    archive_id: candidateArchiveId(item),
    artist: cleanText(item.artist, 300),
    title: cleanText(item.title, 500),
    album: cleanText(item.album, 500),
    spotify_uri: /^spotify:track:[A-Za-z0-9]+$/.test(String(item.spotify_uri || '')) ? item.spotify_uri : null,
    soundcloud_urn: /^soundcloud:tracks:[A-Za-z0-9]+$/.test(String(item.soundcloud_urn || '')) ? item.soundcloud_urn : null,
    soundcloud_url: safeExternalUrl(item.soundcloud_url, 'soundcloud.com'),
    musicbrainz_id: /^[0-9a-f-]{36}$/i.test(String(item.musicbrainz_id || '')) ? item.musicbrainz_id : null,
    shelf_confidence: boundedNumber(item.shelf_confidence),
    recording_confidence: boundedNumber(item.recording_confidence),
    discovery_distance: cleanText(item.discovery_distance || 'one shelf away', 80),
    sources: Array.isArray(item.sources) ? item.sources.map((source) => cleanText(source, 200)).slice(0, 12) : [],
    why: cleanText(item.why, 1000),
    taste_preference: item.taste_preference === 'keep' || item.taste_preference === 'skip' ? item.taste_preference : null,
    taste_adjustment: Math.max(-100, Math.min(100, Number(item.taste_adjustment) || 0)),
    taste_reasons: Array.isArray(item.taste_reasons) ? item.taste_reasons.map((reason) => cleanText(reason, 200)).slice(0, 6) : [],
  };
}
function boundedNumber(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
export function candidateArchiveId(item) {
  if (/^[0-9a-f-]{36}$/i.test(String(item.musicbrainz_id || ''))) return `musicbrainz:${item.musicbrainz_id.toLowerCase()}`;
  if (/^spotify:track:[A-Za-z0-9]+$/.test(String(item.spotify_uri || ''))) return String(item.spotify_uri);
  if (safeExternalUrl(item.soundcloud_url, 'soundcloud.com')) {
    return `soundcloud:${crypto.createHash('sha256').update(item.soundcloud_url).digest('hex').slice(0, 32)}`;
  }
  const identity = `${cleanText(item.artist, 300).toLowerCase()}\n${cleanText(item.title, 500).toLowerCase()}`;
  return `metadata:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}
export function tasteJudgmentSnapshot(item, preference, createdAt, updatedAt = new Date().toISOString()) {
  if (preference !== 'keep' && preference !== 'skip') throw new Error('Taste preference must be keep or skip.');
  const candidate = publicCandidate(item);
  if (!candidate.artist || !candidate.title) throw new Error('Candidate metadata is incomplete.');
  return {
    schema_version: 1,
    archive_id: candidate.archive_id,
    preference,
    created_at: createdAt || updatedAt,
    updated_at: updatedAt,
    artist: candidate.artist,
    title: candidate.title,
    album: candidate.album || null,
    spotify_uri: candidate.spotify_uri,
    soundcloud_url: candidate.soundcloud_url,
    musicbrainz_id: candidate.musicbrainz_id,
    sources: candidate.sources,
  };
}

export async function readTasteProfile(filePath = tasteProfilePath) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    if (payload?.schema_version !== 1 || !Array.isArray(payload.judgments)) {
      throw new Error('Taste profile has an unsupported format.');
    }
    return payload.judgments;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeTasteProfile(filePath, judgments) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    schema_version: 1,
    purpose: 'Local explicit taste judgments used to personalize QRator ranking.',
    judgments,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
}

export function tasteProfileDocument(judgments) {
  return {
    schema_version: 1,
    purpose: 'Local explicit taste judgments used to personalize QRator ranking.',
    usedForRanking: true,
    summary: summarizeTasteProfile(judgments),
    judgments,
  };
}

export function summarizeTasteProfile(judgments) {
  const artistStats = aggregateTaste(judgments, (item) => [item.artist]);
  const sourceStats = aggregateTaste(judgments, (item) => item.sources || []);
  return {
    total: judgments.length,
    kept: judgments.filter((item) => item.preference === 'keep').length,
    skipped: judgments.filter((item) => item.preference === 'skip').length,
    artists: [...artistStats.values()].sort(tasteStatOrder).slice(0, 20),
    sources: [...sourceStats.values()].sort(tasteStatOrder).slice(0, 20),
  };
}

export function rankCandidatesForTaste(items, judgments) {
  const byTrack = new Map(judgments.map((item) => [item.archive_id, item]));
  const byArtist = aggregateTaste(judgments, (item) => [item.artist]);
  const bySource = aggregateTaste(judgments, (item) => item.sources || []);
  return items.map((item, index) => {
    const candidate = publicCandidate(item);
    const exact = byTrack.get(candidate.archive_id);
    const artist = byArtist.get(normalizedTasteKey(candidate.artist));
    const sourceSignals = candidate.sources.map((source) => bySource.get(normalizedTasteKey(source))).filter(Boolean);
    let adjustment = exact?.preference === 'keep' ? 30 : exact?.preference === 'skip' ? -30 : 0;
    const reasons = [];
    if (exact) reasons.push(exact.preference === 'keep' ? 'you marked this track more like you' : 'you marked this track less like you');
    if (artist?.total) {
      const influence = tasteInfluence(artist, 12, 3);
      adjustment += influence;
      if (influence) reasons.push(`${influence > 0 ? 'positive' : 'negative'} history with ${candidate.artist}`);
    }
    if (sourceSignals.length) {
      const sourceInfluence = sourceSignals.reduce((sum, stat) => sum + tasteInfluence(stat, 6, 1.5), 0) / sourceSignals.length;
      adjustment += sourceInfluence;
      if (Math.abs(sourceInfluence) >= 0.5) reasons.push(`${sourceInfluence > 0 ? 'positive' : 'negative'} history with this source`);
    }
    return {
      ...item,
      taste_preference: exact?.preference || null,
      taste_adjustment: Math.round(adjustment * 10) / 10,
      taste_reasons: reasons,
      _taste_order: boundedNumber(item.shelf_confidence) + adjustment,
      _original_order: index,
    };
  }).sort((a, b) => b._taste_order - a._taste_order || a._original_order - b._original_order)
    .map(({ _taste_order, _original_order, ...item }) => item);
}

export function diversifyAcrossShelves(items, length) {
  const target = Math.max(0, Math.min(items.length, Number(length) || 0));
  const remaining = [...items];
  const selected = [];
  const sourceCounts = new Map();
  for (let cap = 1; selected.length < target && remaining.length; cap += 1) {
    for (let index = 0; index < remaining.length && selected.length < target;) {
      const candidate = remaining[index];
      const sources = candidate.sources?.length ? [...new Set(candidate.sources)] : ['Unlabeled shelf'];
      if (sources.every((source) => (sourceCounts.get(source) || 0) >= cap)) {
        index += 1;
        continue;
      }
      selected.push(candidate);
      remaining.splice(index, 1);
      for (const source of sources) sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }
  }
  return selected;
}

function aggregateTaste(judgments, valuesFor) {
  const stats = new Map();
  for (const judgment of judgments) {
    const uniqueValues = new Set(valuesFor(judgment).map((value) => cleanText(value, 300)).filter(Boolean));
    for (const label of uniqueValues) {
      const key = normalizedTasteKey(label);
      const stat = stats.get(key) || { label, kept: 0, skipped: 0, total: 0, net: 0 };
      if (judgment.preference === 'keep') stat.kept += 1;
      if (judgment.preference === 'skip') stat.skipped += 1;
      stat.total += 1;
      stat.net = stat.kept - stat.skipped;
      stats.set(key, stat);
    }
  }
  return stats;
}

function normalizedTasteKey(value) { return normalizedMatchText(value); }
function tasteInfluence(stat, cap, perJudgment) {
  if (!stat?.total) return 0;
  return (stat.net / stat.total) * Math.min(cap, stat.total * perJudgment);
}
function tasteStatOrder(a, b) { return Math.abs(b.net) - Math.abs(a.net) || b.total - a.total || a.label.localeCompare(b.label); }

function queueTasteProfileWrite(action) {
  const next = tasteProfileWrite.then(action, action);
  tasteProfileWrite = next.catch(() => {});
  return next;
}
function safeExternalUrl(value, hostname) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === hostname || url.hostname.endsWith(`.${hostname}`)) ? url.toString() : null;
  } catch { return null; }
}

async function spotifyProxy(res, url) { return json(res, 200, await spotifyFetch(url)); }

export async function spotifyFetch(url, options = {}) {
  await assertProviderReady('spotify');
  const token = await getValidToken();
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text } }; }
  if (response.status === 429) await saveProviderCooldown('spotify', retryAfterSeconds(response.headers.get('retry-after')));
  if (!response.ok) throw spotifyError(response, data);
  return data;
}

function cooldownPath(provider) { return path.join(stateDir, `cooldown-${provider}.json`); }
async function readProviderCooldown(provider) {
  try { return Number(JSON.parse(await readFile(cooldownPath(provider), 'utf8')).until) || 0; }
  catch { return 0; }
}
async function assertProviderReady(provider) {
  const seconds = (await readProviderCooldown(provider)) - Date.now() / 1000;
  if (seconds <= 0) return;
  const error = new Error(`${provider} is cooling down for another ${Math.ceil(seconds)}s; try again after that window.`);
  error.status = 429;
  throw error;
}
async function saveProviderCooldown(provider, seconds) {
  await mkdir(stateDir, { recursive: true });
  const destination = cooldownPath(provider);
  const until = Math.max(await readProviderCooldown(provider), Date.now() / 1000 + Math.max(1, seconds));
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ provider, until }), { mode: 0o600 });
  await rename(temporary, destination);
}
function retryAfterSeconds(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? Math.max(1, (timestamp - Date.now()) / 1000) : 2;
}

export function spotifyError(response, data) {
  const reason = typeof data.error?.reason === 'string' ? data.error.reason : null;
  const message = data.error?.message || data.error_description || `Spotify API failed with ${response.status}`;
  const error = new Error(reason ? `${message} (${reason})` : message);
  error.status = response.status;
  error.reason = reason;
  return error;
}

export async function soundcloudFetch(url, options = {}) {
  await assertProviderReady('soundcloud');
  const token = await getValidSoundcloudToken();
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `OAuth ${token.access_token}`, Accept: 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text } }; }
  if (response.status === 429) await saveProviderCooldown('soundcloud', retryAfterSeconds(response.headers.get('retry-after')));
  if (!response.ok) throw soundcloudError(response, data);
  return data;
}

export async function createSoundcloudPlaylist({ name, description, sharing, trackUrns }) {
  return soundcloudFetch('https://api.soundcloud.com/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlist: { title: name, description, sharing, tracks: trackUrns.map((urn) => ({ urn })) } }),
  });
}

export function soundcloudError(response, data) {
  const message = data.error?.message || data.message || data.error_description || `SoundCloud API failed with ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  return error;
}

async function getValidToken() {
  if (!existsSync(tokenPath)) throw new Error('Spotify is not connected yet.');
  const token = JSON.parse(await readFile(tokenPath, 'utf8'));
  if (Date.now() < token.expires_at - 60_000) return token;
  if (!token.refresh_token) throw new Error('Spotify authorization expired. Connect again.');
  const refreshed = await requestToken({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
  const merged = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token };
  await saveToken(merged);
  return merged;
}

async function requestToken(params) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || `Spotify token request failed with ${response.status}`);
  return data;
}

async function saveToken(token) {
  await writeFile(tokenPath, JSON.stringify({ ...token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 }, null, 2), { mode: 0o600 });
}

async function getValidSoundcloudToken() {
  if (!existsSync(soundcloudTokenPath)) throw new Error('SoundCloud is not connected yet. Use Connect SoundCloud first.');
  const token = JSON.parse(await readFile(soundcloudTokenPath, 'utf8'));
  if (Date.now() < token.expires_at - 60_000) return token;
  if (!token.refresh_token) throw new Error('SoundCloud authorization expired. Connect SoundCloud again.');
  const refreshed = await requestSoundcloudToken({
    grant_type: 'refresh_token', refresh_token: token.refresh_token, redirect_uri: config.soundcloudRedirectUri,
  });
  const merged = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token };
  await saveSoundcloudToken(merged);
  return merged;
}

async function requestSoundcloudToken(params) {
  if (!config.soundcloudClientId || !config.soundcloudClientSecret) throw new Error('SoundCloud client credentials are missing.');
  const response = await fetch('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: config.soundcloudClientId, client_secret: config.soundcloudClientSecret }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || `SoundCloud token request failed with ${response.status}`);
  return data;
}

async function saveSoundcloudToken(token) {
  const destination = soundcloudTokenPath;
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 }, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
}

async function sendFile(res, name, contentType) {
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(await readFile(path.join(publicDir, name)));
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function html(res, status, body) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }
function page(title, body) { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body><main class="callback">${body}</main></body></html>`; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src https://w.soundcloud.com https://open.spotify.com; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}
function pruneStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, created] of pendingStates) if (created < cutoff) pendingStates.delete(key);
  for (const [key, pending] of pendingSoundcloudStates) if (pending.createdAt < cutoff) pendingSoundcloudStates.delete(key);
}
function pruneRuns() { const cutoff = Date.now() - RUN_TTL_MS; for (const [key, run] of discoveryRuns) if (run.createdAt < cutoff) discoveryRuns.delete(key); }

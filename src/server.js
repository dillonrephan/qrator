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
const stateDir = path.join(root, 'data');
const runFile = promisify(execFile);
const MAX_BODY_BYTES = 256 * 1024;
const RUN_TTL_MS = 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

loadEnv(path.join(root, '.env'));

const config = {
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  lastfmApiKey: process.env.LASTFM_API_KEY,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8787/callback',
  port: Number(process.env.PORT || 8787),
};

const scopes = [
  'playlist-modify-private',
  'playlist-modify-public',
  'playlist-read-private',
  'user-read-private',
].join(' ');

const pendingStates = new Map();
const discoveryRuns = new Map();

export const server = http.createServer(handleRequest);

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
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, {
        configured: Boolean(config.clientId && config.clientSecret),
        authenticated: existsSync(tokenPath),
        lastfmConfigured: Boolean(config.lastfmApiKey),
        listenbrainzAvailable: true,
        soundcloudConfigured: Boolean(process.env.SOUNDCLOUD_CLIENT_ID && process.env.SOUNDCLOUD_CLIENT_SECRET),
        redirectUri: config.redirectUri,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') return spotifyProxy(res, 'https://api.spotify.com/v1/me');
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
    if (req.method === 'POST' && url.pathname === '/api/discover') return discover(req, res);
    if (req.method === 'POST' && url.pathname === '/api/discover/playlist') return createDiscoveryPlaylist(req, res);
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    return json(res, Number.isInteger(error.status) ? error.status : 500, {
      error: error.expose === false ? 'Unexpected error.' : error.message || 'Unexpected error.',
    });
  }
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
  const mode = body.mode === 'discover' ? 'discover' : 'distill';
  if (!input) return json(res, 400, { error: 'Add at least two seeds, a source URL, or pasted tracklist text.' });

  const parsed = parseDiscoveryInput(input);
  if (parsed.seeds.length < 2 && parsed.urls.length === 0 && !parsed.text) {
    return json(res, 400, { error: 'Use at least two seeds, a source URL, or pasted tracklist text.' });
  }
  if (mode === 'discover' && parsed.seeds.length < 2) {
    return json(res, 400, { error: 'Expanding a shortlist requires at least two seed tracks or artists.' });
  }

  const runDir = await mkdtemp(path.join(os.tmpdir(), 'qrator-run-'));
  try {
    if (existsSync(tokenPath)) {
      await getValidToken();
      const runTokenPath = path.join(runDir, '.spotify-token.json');
      await copyFile(tokenPath, runTokenPath);
      await chmod(runTokenPath, 0o600);
    }
    const dbPath = path.join(runDir, 'qrator.sqlite');
    const args = ['-m', 'music_harvester.main', '--db', dbPath, mode === 'discover' ? 'discover-from-seeds' : 'create-seeds'];
    if (parsed.seeds.length) args.push(parsed.seedType, ...parsed.seeds);
    if (mode === 'discover') args.push('--search-limit', '10');
    else {
      for (const sourceUrl of parsed.urls) args.push('--source-url', sourceUrl);
      if (parsed.text) args.push('--text', parsed.text);
      if (body.thorough) args.push('--thorough');
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
    const runId = crypto.randomUUID();
    pruneRuns();
    discoveryRuns.set(runId, { createdAt: Date.now(), items });
    return json(res, 200, {
      runId,
      playlist,
      sources,
      unresolved,
      log: completed.stdout,
      seeds: playlistSeeds(items),
      resolved: items.filter((item) => item.spotify_uri).length,
      total: items.length,
      items: items.map(publicCandidate),
      mode,
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

async function createDiscoveryPlaylist(req, res) {
  const body = await readJson(req);
  pruneRuns();
  const runId = String(body.runId || '');
  const run = discoveryRuns.get(runId);
  if (!run) return json(res, 410, { error: 'This discovery run expired. Run discovery again before publishing.' });
  const uris = validSpotifyUris(run.items.map((item) => item.spotify_uri));
  if (!uris.length) return json(res, 400, { error: 'This run has no Spotify-resolved tracks.' });
  const name = cleanText(body.name, 100) || `QRator discovery ${new Date().toISOString().slice(0, 10)}`;
  const playlist = await writePlaylist({
    name,
    description: 'Discovered and reviewed with QRator.',
    isPublic: Boolean(body.public),
    uris,
  });
  return json(res, 201, { playlist, added: uris.length, unresolved: run.items.length - uris.length });
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
  if (seeds.length >= 2) return { seedType: '--tracks', seeds: seeds.slice(0, 4), urls, text: textLines.join('\n') };
  const artistSeeds = lines
    .filter((line) => !/^https?:\/\//i.test(line))
    .flatMap((line) => line.split(/\s+[+&]\s+|,\s*/))
    .map((line) => line.trim()).filter(Boolean);
  return { seedType: '--artists', seeds: artistSeeds.slice(0, 4), urls, text: textLines.join('\n') };
}

export function parseLength(value) {
  const length = Number(value ?? 30);
  if (!Number.isInteger(length) || length < 5 || length > 60) {
    const error = new Error('Playlist length must be a whole number from 5 to 60.');
    error.status = 400;
    throw error;
  }
  return length;
}

function looksLikeTrack(line) { return /\s[-–—:]\s/.test(line) || /\sby\s/i.test(line); }
function cleanText(value, max) { return String(value || '').trim().slice(0, max); }
function validSpotifyUris(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(String(uri))))];
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
    artist: cleanText(item.artist, 300),
    title: cleanText(item.title, 500),
    album: cleanText(item.album, 500),
    spotify_uri: /^spotify:track:[A-Za-z0-9]+$/.test(String(item.spotify_uri || '')) ? item.spotify_uri : null,
    soundcloud_url: safeExternalUrl(item.soundcloud_url, 'soundcloud.com'),
    musicbrainz_id: /^[0-9a-f-]{36}$/i.test(String(item.musicbrainz_id || '')) ? item.musicbrainz_id : null,
    score: Number(item.score) || 0,
    sources: Array.isArray(item.sources) ? item.sources.map((source) => cleanText(source, 200)).slice(0, 12) : [],
    why: cleanText(item.why, 1000),
  };
}
function safeExternalUrl(value, hostname) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === hostname || url.hostname.endsWith(`.${hostname}`)) ? url.toString() : null;
  } catch { return null; }
}

async function spotifyProxy(res, url) { return json(res, 200, await spotifyFetch(url)); }

async function spotifyFetch(url, options = {}) {
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

function spotifyError(response, data) {
  const error = new Error(data.error?.message || data.error_description || `Spotify API failed with ${response.status}`);
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}
function pruneStates() { const cutoff = Date.now() - STATE_TTL_MS; for (const [key, created] of pendingStates) if (created < cutoff) pendingStates.delete(key); }
function pruneRuns() { const cutoff = Date.now() - RUN_TTL_MS; for (const [key, run] of discoveryRuns) if (run.createdAt < cutoff) discoveryRuns.delete(key); }

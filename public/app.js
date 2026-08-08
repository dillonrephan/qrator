const $ = (selector) => document.querySelector(selector);
const selected = new Map();
let currentRun = null;
let currentItems = [];
let currentDiscoveryData = null;
let sessionDecisions = new Map();
let tasteProfile = { summary: { total: 0, kept: 0, skipped: 0, artists: [], sources: [] }, judgments: [] };
let activePlaybackItem = null;
let playerRequestId = 0;

renderSelected();
updateSeedCount();

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `${tab.dataset.view}-view`));
  if (tab.dataset.view === 'profile') refreshProfile();
}));

$('#discover-query').addEventListener('input', (event) => {
  updateSeedCount(event.target.value);
});

$('#discover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runDiscovery({
    query: $('#discover-query').value.trim(),
    length: Number($('#playlist-length').value),
    mode: 'auto',
    thorough: $('#source-thorough').checked,
  });
});

$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#search-query').value.trim();
  if (!query) return;
  setBusy(event.submitter, true, 'Searching');
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    renderTracks($('#results'), data.tracks.items, 'Add', (track) => {
      selected.set(track.uri, track);
      renderSelected();
    });
  } catch (error) { showText($('#results'), error.message, 'error'); }
  finally { setBusy(event.submitter, false); }
});

$('#playlist-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = $('#create-result');
  setBusy(event.submitter, true, 'Publishing');
  result.textContent = '';
  try {
    const playlist = await api('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#playlist-name').value,
        description: $('#playlist-description').value,
        public: $('#playlist-public').checked,
        uris: [...selected.values()].map((track) => track.uri),
      }),
    });
    renderSpotifyLink(result, playlist.external_urls.spotify, 'Open playlist');
  } catch (error) { showText(result, error.message, 'error'); }
  finally { setBusy(event.submitter, false); }
});

$('#clear').addEventListener('click', () => { selected.clear(); renderSelected(); });
$('#export-profile').addEventListener('click', exportProfile);
$('#erase-profile').addEventListener('click', eraseProfile);
$('#player-close').addEventListener('click', closePlayer);
$('#player-fallback').addEventListener('click', () => {
  if (activePlaybackItem) void loadPlayback(activePlaybackItem, 'spotify');
});

document.documentElement.dataset.qratorReady = 'true';
void refreshStatus().catch(() => {
  $('#connection-dot').classList.remove('online');
  $('#status').textContent = 'Provider status unavailable / SoundCloud user-shelf discovery status unknown';
  $('#connect').textContent = 'Connect Spotify';
  $('#connect-soundcloud').textContent = 'Connect SoundCloud';
});
void refreshProfile();

async function refreshStatus() {
  const status = await api('/api/status');
  $('#connection-dot').classList.toggle('online', status.authenticated || status.soundcloudAuthenticated);
  const spotify = status.authenticated ? 'Spotify connected' : status.configured ? 'Spotify ready' : 'Spotify credentials required';
  const soundcloud = status.soundcloudAuthenticated ? 'SoundCloud connected' : status.soundcloudConfigured ? 'SoundCloud ready' : 'SoundCloud credentials required';
  const discovery = status.soundcloudAuthenticated
    ? 'User likes + playlist discovery ready'
    : 'Connect SoundCloud for user-shelf discovery';
  $('#status').textContent = `${spotify} / ${soundcloud} / ${discovery}`;
  $('#connect').textContent = status.authenticated ? 'Reconnect Spotify' : 'Connect Spotify';
  $('#connect-soundcloud').textContent = status.soundcloudAuthenticated ? 'Reconnect SoundCloud' : 'Connect SoundCloud';
}

async function runDiscovery(payload, { playFirst = false } = {}) {
  if (!payload.query) return;
  closePlayer();
  const button = $('#discover-button');
  setBusy(button, true, payload.mode === 'discover' ? 'Expanding' : 'Curating');
  $('#discover-empty').hidden = true;
  $('#discover-output').hidden = false;
  $('#result-title').textContent = payload.mode === 'discover' ? 'Expanding shortlist' : 'Building shortlist';
  $('#result-stats').innerHTML = '<span class="running">Processing sources</span>';
  $('#discover-output').innerHTML = '<div class="progress"><i></i></div>';
  try {
    const data = await api('/api/discover', { method: 'POST', body: JSON.stringify(payload) });
    currentRun = data.runId;
    currentItems = data.items || [];
    currentDiscoveryData = data;
    sessionDecisions = new Map(currentItems.filter((item) => item.taste_preference).map((item) => [item.archive_id, item.taste_preference]));
    renderDiscovery(data);
    if (playFirst && currentItems.length) await loadPlayback(currentItems[0]);
  } catch (error) {
    currentRun = null;
    currentItems = [];
    currentDiscoveryData = null;
    sessionDecisions = new Map();
    $('#result-title').textContent = 'Discovery failed';
    $('#result-stats').innerHTML = '';
    showText($('#discover-output'), error.message, 'error error-panel');
  } finally { setBusy(button, false); }
}

function renderDiscovery(data) {
  $('#result-title').textContent = data.mode === 'discover' ? 'Discovery playlist' : 'Seed shortlist';
  renderDiscoveryStats(data);
  const sections = [
    ['Shortlist', data.playlist],
    ['Sources', data.sources],
    ['Unresolved', data.unresolved],
    ['Run log', data.log],
  ].filter(([, content]) => content?.trim());

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const expansionSeeds = seedsForExpansion();
  if (expansionSeeds.length >= 2) {
    const expand = button('Expand from shortlist', 'secondary', () => runDiscovery({
      query: seedsForExpansion().join('\n'), length: Number($('#playlist-length').value), mode: 'discover', thorough: false,
    }));
    actions.append(expand);
  }
  if (publishItems().some((item) => item.artist && item.title)) {
    actions.append(button('Publish to SoundCloud', 'primary', () => openPublish('soundcloud')));
  }
  if (publishItems().some((item) => item.spotify_uri)) {
    actions.append(button('Publish to Spotify', 'secondary', () => openPublish('spotify')));
  }
  const memoryNote = document.createElement('small');
  memoryNote.className = 'session-note';
  memoryNote.textContent = 'Your judgments are saved locally and shape the order of future discoveries.';
  actions.append(memoryNote);

  const output = $('#discover-output');
  output.innerHTML = '';
  output.append(actions);
  if (data.items?.length) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Shortlist';
    const list = document.createElement('div');
    list.className = 'candidate-list';
    for (const [index, item] of currentItems.entries()) list.append(renderCandidate(item, index + 1));
    details.append(summary, list);
    output.append(details);
  }
  for (const [title, content] of sections) {
    if (title === 'Shortlist' && data.items?.length) continue;
    const details = document.createElement('details');
    details.open = title === 'Shortlist';
    const summary = document.createElement('summary');
    summary.textContent = title;
    const pre = document.createElement('pre');
    pre.textContent = content.trim();
    details.append(summary, pre);
    output.append(details);
  }
}

function renderDiscoveryStats(data) {
  const kept = decisionCount('keep');
  const skipped = decisionCount('skip');
  const parts = [
    `<span>${data.resolved} Spotify-ready</span>`,
    `<span>${data.total - data.resolved} catalog-only</span>`,
  ];
  if (kept) parts.push(`<span>${kept} more like this</span>`);
  if (skipped) parts.push(`<span>${skipped} less like this</span>`);
  $('#result-stats').innerHTML = parts.join('');
}

function renderCandidate(item, index) {
  const row = document.createElement('article');
  const decision = sessionDecisions.get(item.archive_id);
  row.className = ['candidate', decision ? `candidate-${decision}` : ''].filter(Boolean).join(' ');
  const number = document.createElement('span');
  number.className = 'candidate-number';
  number.textContent = String(index).padStart(2, '0');
  const body = document.createElement('div');
  body.className = 'candidate-body';
  const title = document.createElement('strong');
  title.textContent = item.title;
  const artist = document.createElement('span');
  artist.textContent = [item.artist, item.album].filter(Boolean).join(' — ');
  const why = document.createElement('small');
  why.textContent = item.why;
  const tasteWhy = document.createElement('small');
  tasteWhy.className = 'taste-reason';
  tasteWhy.textContent = item.taste_reasons?.length ? `Taste profile: ${item.taste_reasons.join('; ')}.` : '';
  const evidence = document.createElement('div');
  evidence.className = 'candidate-evidence';
  evidence.append(
    metric(`${item.shelf_confidence.toFixed(1)}`, 'shelf confidence'),
    metric(item.discovery_distance, 'distance'),
    metric(`${item.recording_confidence.toFixed(1)}`, 'recording confidence'),
  );
  if (item.taste_adjustment) evidence.append(metric(`${item.taste_adjustment > 0 ? '+' : ''}${item.taste_adjustment.toFixed(1)}`, 'taste influence'));
  const links = document.createElement('div');
  links.className = 'candidate-links';
  if (item.spotify_uri) links.append(externalLink(`https://open.spotify.com/track/${item.spotify_uri.split(':').at(-1)}`, 'Spotify'));
  if (item.soundcloud_url) links.append(externalLink(item.soundcloud_url, 'SoundCloud'));
  if (item.musicbrainz_id) links.append(externalLink(`https://musicbrainz.org/recording/${item.musicbrainz_id}`, 'MusicBrainz'));
  const query = encodeURIComponent(`${item.artist} ${item.title}`);
  links.append(externalLink(`https://www.youtube.com/results?search_query=${query}`, 'YouTube search'));
  links.append(externalLink(`https://soundcloud.com/search/sounds?q=${query}`, 'SoundCloud search'));
  const review = document.createElement('div');
  review.className = 'candidate-review';
  const play = button('Play here', 'review-button play-button', (event) => loadPlayback(item, 'soundcloud', event.currentTarget));
  play.title = 'Load the SoundCloud player first, with Spotify as fallback.';
  const keep = button(
    decision === 'keep' ? 'More like me' : 'More like this',
    decision === 'keep' ? 'review-button active-keep' : 'review-button',
    () => setTasteDecision(item, decision === 'keep' ? null : 'keep'),
  );
  keep.setAttribute('aria-pressed', String(decision === 'keep'));
  const skip = button(
    decision === 'skip' ? 'Less like me' : 'Less like this',
    decision === 'skip' ? 'review-button active-skip' : 'review-button',
    () => setTasteDecision(item, decision === 'skip' ? null : 'skip'),
  );
  skip.setAttribute('aria-pressed', String(decision === 'skip'));
  review.append(play, keep, skip);
  body.append(title, artist, evidence, why);
  if (tasteWhy.textContent) body.append(tasteWhy);
  body.append(review, links);
  row.append(number, body);
  return row;
}

async function setTasteDecision(item, decision) {
  const archiveId = item.archive_id;
  const previous = sessionDecisions.get(archiveId) || null;
  if (decision) sessionDecisions.set(archiveId, decision);
  else sessionDecisions.delete(archiveId);
  renderDiscovery(currentDiscoveryData);
  try {
    if (decision) {
      const data = await api('/api/profile/judgments', {
        method: 'PUT',
        body: JSON.stringify({ runId: currentRun, archiveId, preference: decision }),
      });
      tasteProfile = data.profile;
    } else {
      tasteProfile = await api(`/api/profile/judgments/${encodeURIComponent(archiveId)}`, { method: 'DELETE' });
    }
    renderProfile();
    if (decision) await advanceAfterTasteJudgment(item, decision);
  } catch (error) {
    if (previous) sessionDecisions.set(archiveId, previous);
    else sessionDecisions.delete(archiveId);
    renderDiscovery(currentDiscoveryData);
    window.alert(error.message);
  }
}

async function advanceAfterTasteJudgment(item, decision) {
  const currentIndex = currentItems.findIndex((candidate) => candidate.archive_id === item.archive_id);
  const queueAfterCurrent = currentIndex < 0
    ? currentItems
    : [...currentItems.slice(currentIndex + 1), ...currentItems.slice(0, currentIndex)];
  const next = queueAfterCurrent.find((candidate) => !sessionDecisions.has(candidate.archive_id));
  if (next) {
    await loadPlayback(next);
    return;
  }
  if (decision !== 'keep') {
    $('#player-status').textContent = 'End of this shortlist. Mark a track More like this to keep exploring.';
    return;
  }
  const seeds = seedsForExpansion().slice(0, 20);
  if (seeds.length < 2) {
    $('#player-status').textContent = 'QRator needs at least two non-skipped shortlist tracks to find a real overlapping shelf.';
    return;
  }
  await runDiscovery({
    query: seeds.join('\n'),
    length: Number($('#playlist-length').value),
    mode: 'discover',
    thorough: false,
  }, { playFirst: true });
}

function decisionCount(decision) {
  return [...sessionDecisions.values()].filter((value) => value === decision).length;
}

function publishItems() {
  return currentItems.filter((item) => sessionDecisions.get(item.archive_id) !== 'skip');
}

function seedsForExpansion() {
  const kept = currentItems.filter((item) => sessionDecisions.get(item.archive_id) === 'keep');
  const otherNonSkipped = publishItems().filter((item) => !kept.some((keptItem) => keptItem.archive_id === item.archive_id));
  const seeds = [...kept, ...otherNonSkipped]
    .map((item) => `${item.artist} - ${item.title}`.trim())
    .filter(Boolean);
  return [...new Set(seeds)].slice(0, 12);
}

function metric(value, label) {
  const element = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = value;
  const small = document.createElement('small');
  small.textContent = label;
  element.append(strong, small);
  return element;
}

async function loadPlayback(item, preferredProvider = 'soundcloud', trigger = null) {
  const requestId = ++playerRequestId;
  activePlaybackItem = item;
  const shell = $('#player-shell');
  shell.hidden = false;
  $('#player-title').textContent = item.title;
  $('#player-artist').textContent = item.artist;
  $('#player-provider').textContent = preferredProvider === 'spotify' ? 'Spotify fallback' : 'SoundCloud first';
  $('#player-status').textContent = preferredProvider === 'spotify' ? 'Loading Spotify player…' : 'Looking for a strict SoundCloud match…';
  $('#player-frame').innerHTML = '';
  $('#player-fallback').hidden = true;
  setBusy(trigger, true, 'Loading player');
  shell.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    let playback;
    if (preferredProvider === 'spotify') {
      playback = spotifyPlayback(item);
      if (!playback) throw new Error('This track has no Spotify fallback.');
    } else {
      playback = await api('/api/discover/playback', {
        method: 'POST',
        body: JSON.stringify({ runId: currentRun, archiveId: item.archive_id }),
      });
    }
    if (requestId !== playerRequestId) return;
    renderEmbeddedPlayer(item, playback);
  } catch (error) {
    if (requestId !== playerRequestId) return;
    $('#player-provider').textContent = 'Playback unavailable';
    $('#player-status').textContent = error.message;
    $('#player-fallback').hidden = !item.spotify_uri || preferredProvider === 'spotify';
  } finally {
    setBusy(trigger, false);
  }
}

function spotifyPlayback(item) {
  const id = String(item.spotify_uri || '').match(/^spotify:track:([A-Za-z0-9]+)$/)?.[1];
  return id ? { provider: 'spotify', url: `https://open.spotify.com/track/${id}`, resolution: 'manual-fallback' } : null;
}

function renderEmbeddedPlayer(item, playback) {
  const frame = document.createElement('iframe');
  frame.title = `${playback.provider === 'soundcloud' ? 'SoundCloud' : 'Spotify'} player for ${item.artist} — ${item.title}`;
  frame.loading = 'eager';
  frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
  frame.referrerPolicy = 'no-referrer';
  if (playback.provider === 'soundcloud') {
    const source = new URL('https://w.soundcloud.com/player/');
    source.searchParams.set('url', playback.url);
    source.searchParams.set('auto_play', 'true');
    source.searchParams.set('hide_related', 'true');
    source.searchParams.set('show_comments', 'false');
    source.searchParams.set('show_reposts', 'false');
    source.searchParams.set('visual', 'false');
    frame.src = source.toString();
    frame.height = '166';
    $('#player-provider').textContent = playback.resolution === 'strict-search' ? 'SoundCloud · strict match' : 'SoundCloud';
    $('#player-status').textContent = 'SoundCloud is QRator’s default player.';
    $('#player-fallback').hidden = !item.spotify_uri;
  } else {
    const id = new URL(playback.url).pathname.split('/').filter(Boolean).at(-1);
    frame.src = `https://open.spotify.com/embed/track/${encodeURIComponent(id)}`;
    frame.height = '152';
    $('#player-provider').textContent = 'Spotify fallback';
    $('#player-status').textContent = 'No strict SoundCloud playback source was available.';
    $('#player-fallback').hidden = true;
  }
  frame.width = '100%';
  frame.setAttribute('frameborder', '0');
  $('#player-frame').replaceChildren(frame);
}

function closePlayer() {
  playerRequestId += 1;
  activePlaybackItem = null;
  $('#player-frame').innerHTML = '';
  $('#player-status').textContent = '';
  $('#player-shell').hidden = true;
}

async function refreshProfile() {
  try {
    tasteProfile = await api('/api/profile');
    renderProfile();
  } catch (error) {
    showText($('#profile-output'), error.message, 'error error-panel');
  }
}

function renderProfile() {
  const summary = tasteProfile.summary || { total: 0, kept: 0, skipped: 0, artists: [], sources: [] };
  $('#profile-title').textContent = summary.total ? 'QRator is learning your shape' : 'No taste signals yet';
  $('#profile-stats').innerHTML = `<span>${summary.total} judgments</span><span>${summary.kept} more like this</span><span>${summary.skipped} less like this</span>`;
  const summaryOutput = $('#profile-summary');
  summaryOutput.innerHTML = '';
  if (summary.total) {
    summaryOutput.append(profileFacet('Artist signals', summary.artists), profileFacet('Source signals', summary.sources));
  }
  const output = $('#profile-output');
  output.innerHTML = '';
  if (!tasteProfile.judgments?.length) {
    return showText(output, 'Judge tracks in Discover and QRator will build an inspectable profile here.', 'muted-empty');
  }
  for (const [index, judgment] of tasteProfile.judgments.entries()) {
    const row = document.createElement('article');
    row.className = `candidate candidate-${judgment.preference}`;
    const number = document.createElement('span');
    number.className = 'candidate-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const body = document.createElement('div');
    body.className = 'candidate-body';
    const title = document.createElement('strong');
    title.textContent = judgment.title;
    const artist = document.createElement('span');
    artist.textContent = judgment.artist;
    const detail = document.createElement('small');
    detail.textContent = `${judgment.preference === 'keep' ? 'More like this' : 'Less like this'} · updated ${new Date(judgment.updated_at).toLocaleString()}`;
    const remove = button('Remove this judgment', 'remove-button', () => removeTasteJudgment(judgment));
    body.append(title, artist, detail, remove);
    row.append(number, body);
    output.append(row);
  }
}

function profileFacet(title, stats = []) {
  const section = document.createElement('section');
  section.className = 'profile-facet';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const values = document.createElement('div');
  values.className = 'stats';
  for (const stat of stats.slice(0, 10)) {
    const pill = document.createElement('span');
    pill.textContent = `${stat.label}: ${stat.net > 0 ? '+' : ''}${stat.net}`;
    values.append(pill);
  }
  if (!stats.length) values.textContent = 'Not enough signal yet.';
  section.append(heading, values);
  return section;
}

async function removeTasteJudgment(judgment) {
  if (!window.confirm(`Remove your taste judgment for “${judgment.artist} — ${judgment.title}”?`)) return;
  tasteProfile = await api(`/api/profile/judgments/${encodeURIComponent(judgment.archive_id)}`, { method: 'DELETE' });
  sessionDecisions.delete(judgment.archive_id);
  if (currentDiscoveryData) renderDiscovery(currentDiscoveryData);
  renderProfile();
}

async function eraseProfile() {
  if (!window.confirm('Erase every taste judgment? QRator will stop personalizing future discovery until you teach it again.')) return;
  tasteProfile = await api('/api/profile', { method: 'DELETE' });
  sessionDecisions.clear();
  if (currentDiscoveryData) renderDiscovery(currentDiscoveryData);
  renderProfile();
}

function exportProfile() {
  const payload = JSON.stringify(tasteProfile, null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${payload}\n`], { type: 'application/json' }));
  link.download = `qrator-taste-profile-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function externalLink(href, label) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  return link;
}

function openPublish(provider) {
  const output = $('#discover-output');
  output.querySelector('.publish-bar')?.remove();
  const form = document.createElement('form');
  form.className = 'publish-bar';
  const spotifyCount = publishItems().filter((item) => item.spotify_uri).length;
  const soundcloudCount = publishItems().length;
  const count = provider === 'soundcloud' ? soundcloudCount : spotifyCount;
  const destination = provider === 'soundcloud' ? 'SoundCloud' : 'Spotify';
  form.dataset.provider = provider;
  form.innerHTML = `<label><span>Playlist name</span><input name="name" maxlength="100" value="QRator discovery"></label><label class="toggle-row compact"><span><strong>Public</strong></span><input name="public" type="checkbox"></label><button class="primary" type="submit">Publish ${count} to ${destination}</button><span class="publish-result"></span>`;
  form.addEventListener('submit', provider === 'soundcloud' ? publishSoundcloudDiscovery : publishDiscovery);
  output.prepend(form);
  form.elements.name.focus();
}

async function publishSoundcloudDiscovery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const result = form.querySelector('.publish-result');
  setBusy(event.submitter, true, 'Resolving & publishing');
  try {
    const data = await api('/api/discover/soundcloud-playlist', {
      method: 'POST',
      body: JSON.stringify({
        runId: currentRun,
        name: form.elements.name.value,
        public: form.elements.public.checked,
        archiveIds: publishItems().map((item) => item.archive_id),
      }),
    });
    renderSpotifyLink(result, data.playlist.permalink_url, `Open SoundCloud playlist (${data.added}; ${data.unresolved} unresolved)`);
  } catch (error) { showText(result, error.message, 'error'); }
  finally { setBusy(event.submitter, false); }
}

async function publishDiscovery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const result = form.querySelector('.publish-result');
  setBusy(event.submitter, true, 'Publishing');
  try {
    const data = await api('/api/discover/playlist', {
      method: 'POST',
      body: JSON.stringify({
        runId: currentRun,
        name: form.elements.name.value,
        public: form.elements.public.checked,
        archiveIds: publishItems().map((item) => item.archive_id),
      }),
    });
    renderSpotifyLink(result, data.playlist.external_urls.spotify, `Open playlist (${data.added})`);
  } catch (error) { showText(result, error.message, 'error'); }
  finally { setBusy(event.submitter, false); }
}

function renderSelected() {
  const target = $('#selected');
  renderTracks(target, [...selected.values()], 'Remove', (track) => { selected.delete(track.uri); renderSelected(); });
  if (!selected.size) showText(target, 'No tracks selected.', 'muted-empty');
}

function renderTracks(target, tracks, action, onClick) {
  target.innerHTML = '';
  if (!tracks?.length) return showText(target, 'No tracks found.', 'muted-empty');
  for (const track of tracks) {
    const row = document.createElement('article');
    row.className = 'track';
    const image = document.createElement('img');
    image.src = track.album.images.at(-1)?.url || '';
    image.alt = '';
    const text = document.createElement('div');
    text.className = 'track-text';
    const strong = document.createElement('strong');
    strong.textContent = track.name;
    const artist = document.createElement('span');
    artist.textContent = track.artists.map((item) => item.name).join(', ');
    text.append(strong, artist);
    row.append(image, text, button(action, 'text-button', () => onClick(track)));
    target.append(row);
  }
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function setBusy(element, busy, label) {
  if (!element) return;
  if (busy) { element.dataset.label = element.textContent; element.textContent = label; element.disabled = true; }
  else { element.textContent = element.dataset.label || element.textContent; element.disabled = false; }
}
function showText(element, text, className = '') { element.innerHTML = ''; element.className = className; element.textContent = text; }
function renderSpotifyLink(element, href, label) {
  element.innerHTML = '';
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  element.append(link);
}
function updateSeedCount(value = $('#discover-query').value) {
  const count = value.split(/\r?\n/).filter((line) => line.trim()).length;
  $('#seed-count').textContent = `${count} ${count === 1 ? 'line' : 'lines'}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
  return data;
}

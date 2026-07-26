const $ = (selector) => document.querySelector(selector);
const selected = new Map();
let currentRun = null;
let latestSeeds = [];
let savedTracks = [];
let savedArchiveIds = new Set();

await refreshStatus();
await refreshLibrary();
renderSelected();
updateSeedCount();

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `${tab.dataset.view}-view`));
  if (tab.dataset.view === 'library') refreshLibrary();
}));

$('#discover-query').addEventListener('input', (event) => {
  updateSeedCount(event.target.value);
});

$('#discover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runDiscovery({
    query: $('#discover-query').value.trim(),
    length: Number($('#playlist-length').value),
    mode: 'distill',
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
$('#export-library').addEventListener('click', exportLibrary);

async function refreshStatus() {
  const status = await api('/api/status');
  $('#connection-dot').classList.toggle('online', status.authenticated);
  const spotify = status.authenticated ? 'Spotify connected' : status.configured ? 'Spotify ready' : 'Spotify credentials required';
  const discovery = status.lastfmConfigured ? 'ListenBrainz + Last.fm discovery' : 'ListenBrainz discovery ready';
  $('#status').textContent = `${spotify} / ${discovery}`;
  $('#connect').textContent = status.authenticated ? 'Reconnect' : 'Connect';
}

async function runDiscovery(payload) {
  if (!payload.query) return;
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
    latestSeeds = data.seeds || [];
    renderDiscovery(data);
  } catch (error) {
    currentRun = null;
    $('#result-title').textContent = 'Discovery failed';
    $('#result-stats').innerHTML = '';
    showText($('#discover-output'), error.message, 'error error-panel');
  } finally { setBusy(button, false); }
}

function renderDiscovery(data) {
  $('#result-title').textContent = data.mode === 'discover' ? 'Discovery playlist' : 'Seed shortlist';
  $('#result-stats').innerHTML = `<span>${data.resolved} Spotify-ready</span><span>${data.total - data.resolved} catalog-only</span>`;
  const sections = [
    ['Shortlist', data.playlist],
    ['Sources', data.sources],
    ['Unresolved', data.unresolved],
    ['Run log', data.log],
  ].filter(([, content]) => content?.trim());

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  if (latestSeeds.length >= 2) {
    const expand = button('Expand from shortlist', 'secondary', () => runDiscovery({
      query: latestSeeds.join('\n'), length: Number($('#playlist-length').value), mode: 'discover', thorough: false,
    }));
    actions.append(expand);
  }
  if (data.resolved) actions.append(button('Publish to Spotify', 'primary', openPublish));

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
    for (const [index, item] of data.items.entries()) list.append(renderCandidate(item, index + 1));
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

function renderCandidate(item, index) {
  const row = document.createElement('article');
  row.className = 'candidate';
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
  const evidence = document.createElement('div');
  evidence.className = 'candidate-evidence';
  evidence.append(
    metric(`${item.shelf_confidence.toFixed(1)}`, 'shelf confidence'),
    metric(item.discovery_distance, 'distance'),
    metric(`${item.recording_confidence.toFixed(1)}`, 'recording confidence'),
  );
  const links = document.createElement('div');
  links.className = 'candidate-links';
  if (item.spotify_uri) links.append(externalLink(`https://open.spotify.com/track/${item.spotify_uri.split(':').at(-1)}`, 'Spotify'));
  if (item.soundcloud_url) links.append(externalLink(item.soundcloud_url, 'SoundCloud'));
  if (item.musicbrainz_id) links.append(externalLink(`https://musicbrainz.org/recording/${item.musicbrainz_id}`, 'MusicBrainz'));
  const query = encodeURIComponent(`${item.artist} ${item.title}`);
  links.append(externalLink(`https://www.youtube.com/results?search_query=${query}`, 'YouTube search'));
  links.append(externalLink(`https://soundcloud.com/search/sounds?q=${query}`, 'SoundCloud search'));
  const save = button(
    savedArchiveIds.has(item.archive_id) ? 'Metadata saved' : 'Save this track’s metadata forever',
    'archive-button',
    (event) => archiveTrack(item, event.currentTarget),
  );
  save.disabled = savedArchiveIds.has(item.archive_id);
  links.append(save);
  body.append(title, artist, evidence, why, links);
  row.append(number, body);
  return row;
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

async function archiveTrack(item, archiveButton) {
  setBusy(archiveButton, true, 'Saving metadata');
  try {
    const data = await api('/api/library', {
      method: 'POST',
      body: JSON.stringify({ runId: currentRun, archiveId: item.archive_id }),
    });
    savedArchiveIds.add(data.track.archive_id);
    archiveButton.dataset.label = 'Metadata saved';
  } catch (error) {
    archiveButton.dataset.label = 'Try saving again';
    window.alert(error.message);
  } finally {
    setBusy(archiveButton, false);
    archiveButton.disabled = savedArchiveIds.has(item.archive_id);
  }
}

async function refreshLibrary() {
  try {
    const data = await api('/api/library');
    savedTracks = data.tracks || [];
    savedArchiveIds = new Set(savedTracks.map((track) => track.archive_id));
    renderLibrary();
  } catch (error) {
    showText($('#library-output'), error.message, 'error error-panel');
  }
}

function renderLibrary() {
  const output = $('#library-output');
  output.innerHTML = '';
  $('#library-title').textContent = savedTracks.length ? 'Metadata kept on purpose' : 'Nothing saved';
  $('#library-stats').innerHTML = `<span>${savedTracks.length} saved</span><span>not used for ranking</span>`;
  if (!savedTracks.length) {
    return showText(output, 'Save a candidate explicitly and its metadata will appear here.', 'muted-empty');
  }
  for (const [index, track] of savedTracks.entries()) {
    const row = renderSavedTrack(track, index + 1);
    output.append(row);
  }
}

function renderSavedTrack(track, index) {
  const row = document.createElement('article');
  row.className = 'candidate';
  const number = document.createElement('span');
  number.className = 'candidate-number';
  number.textContent = String(index).padStart(2, '0');
  const body = document.createElement('div');
  body.className = 'candidate-body';
  const title = document.createElement('strong');
  title.textContent = track.title;
  const artist = document.createElement('span');
  artist.textContent = [track.artist, track.album].filter(Boolean).join(' — ');
  const saved = document.createElement('small');
  saved.textContent = `Saved ${new Date(track.saved_at).toLocaleString()} · never used for ranking`;
  const actions = document.createElement('div');
  actions.className = 'candidate-links';
  if (track.spotify_uri) actions.append(externalLink(`https://open.spotify.com/track/${track.spotify_uri.split(':').at(-1)}`, 'Spotify'));
  if (track.soundcloud_url) actions.append(externalLink(track.soundcloud_url, 'SoundCloud'));
  if (track.musicbrainz_id) actions.append(externalLink(`https://musicbrainz.org/recording/${track.musicbrainz_id}`, 'MusicBrainz'));
  actions.append(button('Remove saved metadata', 'remove-button', () => removeArchivedTrack(track)));
  body.append(title, artist, saved, actions);
  row.append(number, body);
  return row;
}

async function removeArchivedTrack(track) {
  if (!window.confirm(`Remove the saved metadata for “${track.artist} — ${track.title}”?`)) return;
  await api(`/api/library/${encodeURIComponent(track.archive_id)}`, { method: 'DELETE' });
  await refreshLibrary();
}

function exportLibrary() {
  const payload = JSON.stringify({
    schema_version: 1,
    purpose: 'Explicitly saved track metadata. Never used for ranking.',
    tracks: savedTracks,
  }, null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${payload}\n`], { type: 'application/json' }));
  link.download = `qrator-saved-metadata-${new Date().toISOString().slice(0, 10)}.json`;
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

function openPublish() {
  const output = $('#discover-output');
  output.querySelector('.publish-bar')?.remove();
  const form = document.createElement('form');
  form.className = 'publish-bar';
  form.innerHTML = '<label><span>Playlist name</span><input name="name" maxlength="100" value="QRator discovery"></label><label class="toggle-row compact"><span><strong>Public</strong></span><input name="public" type="checkbox"></label><button class="primary" type="submit">Confirm publish</button><span class="publish-result"></span>';
  form.addEventListener('submit', publishDiscovery);
  output.prepend(form);
  form.elements.name.focus();
}

async function publishDiscovery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const result = form.querySelector('.publish-result');
  setBusy(event.submitter, true, 'Publishing');
  try {
    const data = await api('/api/discover/playlist', {
      method: 'POST',
      body: JSON.stringify({ runId: currentRun, name: form.elements.name.value, public: form.elements.public.checked }),
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

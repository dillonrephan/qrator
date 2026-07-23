const $ = (selector) => document.querySelector(selector);
const selected = new Map();
let currentRun = null;
let latestSeeds = [];

await refreshStatus();
renderSelected();

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `${tab.dataset.view}-view`));
}));

$('#discover-query').addEventListener('input', (event) => {
  const count = event.target.value.split(/\r?\n/).filter((line) => line.trim()).length;
  $('#seed-count').textContent = `${count} ${count === 1 ? 'line' : 'lines'}`;
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

async function refreshStatus() {
  const status = await api('/api/status');
  $('#connection-dot').classList.toggle('online', status.authenticated);
  const spotify = status.authenticated ? 'Spotify connected' : status.configured ? 'Spotify ready' : 'Spotify credentials required';
  $('#status').textContent = `${spotify} / ${status.lastfmConfigured ? 'Last.fm active' : 'Last.fm key needed'}`;
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
  $('#result-stats').innerHTML = `<span>${data.resolved} resolved</span><span>${data.total - data.resolved} unresolved</span>`;
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
  actions.append(button('Publish to Spotify', 'primary', openPublish));

  const output = $('#discover-output');
  output.innerHTML = '';
  output.append(actions);
  for (const [title, content] of sections) {
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

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
  return data;
}

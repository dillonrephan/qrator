#!/usr/bin/env node

const endpoint = process.argv[2];
const inspectPlaylists = process.argv.includes("--playlists");
const compact = process.argv.includes("--compact");
if (!endpoint) {
  console.error("Usage: spotify-bidi-inspect.mjs <WebDriver BiDi endpoint>");
  process.exit(2);
}

const socket = new WebSocket(endpoint);
const pending = new Map();
let nextId = 1;

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.type === "error") reject(new Error(`${message.error}: ${message.message}`));
  else resolve(message.result);
});

const command = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

let sessionCreated = false;
try {
  await command("session.new", { capabilities: { alwaysMatch: {} } });
  sessionCreated = true;
  const tree = await command("browsingContext.getTree");
  const context = tree.contexts.find((item) => item.url?.includes("open.spotify.com"))?.context;
  if (!context) throw new Error("No Spotify browsing context found");

  const evaluate = async (expression) => {
    const result = await command("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: false,
    });
    if (result.realm === undefined || result.result?.type !== "string") {
      throw new Error(`Unexpected script result: ${JSON.stringify(result).slice(0, 500)}`);
    }
    return JSON.parse(result.result.value);
  };

  if (inspectPlaylists) {
    await evaluate(`JSON.stringify((() => {
      window.__qratorFetches = [];
      if (!window.__qratorOriginalFetch) {
        window.__qratorOriginalFetch = window.fetch;
        window.fetch = function(input, init = {}) {
          const url = typeof input === 'string' ? input : input?.url || '';
          if (url.includes('api-partner.spotify.com')) {
            window.__qratorFetches.push({
              url,
              method: init.method || input?.method || 'GET',
              body: typeof init.body === 'string' ? init.body : null
            });
          }
          return window.__qratorOriginalFetch.apply(this, arguments);
        };
      }
      const link = [...document.querySelectorAll('a[href]')]
        .find((a) => a.href.endsWith('/user/31vgsgyybbanzztgfqblpulb7gsq/playlists'));
      if (!link) return { clicked: false };
      link.click();
      return { clicked: true };
    })())`);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    for (let pass = 0; pass < 12; pass += 1) {
      const state = await evaluate(`JSON.stringify((() => {
        const candidates = [...document.querySelectorAll('*')]
          .filter((element) => element.scrollHeight > element.clientHeight + 100);
        const scroller = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        return {
          playlistLinks: new Set([...document.querySelectorAll('a[href*="/playlist/"]')]
            .map((a) => a.href.split('?')[0])).size,
          scrollTop: scroller?.scrollTop || 0,
          scrollHeight: scroller?.scrollHeight || 0
        };
      })())`);
      if (state.playlistLinks >= 76) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  const expression = `JSON.stringify({
    title: document.title,
    url: location.href,
    links: [...document.querySelectorAll('a[href]')]
      .map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim(), href: a.href }))
      .filter((item) => item.text || item.href.includes('/playlist/')),
    spotifyResources: performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => url.includes('api-partner.spotify.com') || url.includes('api.spotify.com')),
    capturedFetches: window.__qratorFetches || []
    ,mainText: (document.querySelector('main')?.innerText || '').slice(0, 1200)
    ,trackRows: document.querySelectorAll('[data-testid="tracklist-row"]').length
    ,scrollables: [...document.querySelectorAll('*')]
      .filter((element) => element.scrollHeight > element.clientHeight + 100)
      .map((element) => ({
        tag: element.tagName,
        testid: element.getAttribute('data-testid'),
        role: element.getAttribute('role'),
        className: String(element.className).slice(0, 180),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        overflowY: getComputedStyle(element).overflowY
      }))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 20)
  })`;
  const snapshot = await evaluate(expression);
  console.log(
    JSON.stringify(
      compact
        ? {
            title: snapshot.title,
            url: snapshot.url,
            trackRows: snapshot.trackRows,
            mainText: snapshot.mainText,
            scrollables: snapshot.scrollables,
          }
        : snapshot,
    ),
  );
} finally {
  if (sessionCreated && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: nextId++, method: "session.end", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  socket.close();
}

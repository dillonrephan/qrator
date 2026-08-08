#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const profileUrl = args.shift();
if (!profileUrl) {
  console.error(
    "Usage: spotify-browser-overlap.mjs <profile URL> --bidi <endpoint> [--out DIR] [--limit N]",
  );
  process.exit(2);
}

const options = {
  bidi: null,
  out: path.resolve("output/spotify-browser-overlap"),
  limit: null,
  only: null,
};
while (args.length) {
  const arg = args.shift();
  if (arg === "--bidi" && args.length) options.bidi = args.shift();
  else if (arg === "--out" && args.length) options.out = path.resolve(args.shift());
  else if (arg === "--limit" && args.length) options.limit = Number(args.shift());
  else if (arg === "--only" && args.length) options.only = new Set(args.shift().split(","));
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
if (!options.bidi) throw new Error("--bidi is required");

const profile = new URL(profileUrl);
const userId = profile.pathname.match(/^\/user\/([^/]+)/)?.[1];
if (!userId) throw new Error("Expected an open.spotify.com user profile URL");
const playlistsUrl = `https://open.spotify.com/user/${userId}/playlists`;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectBidi(endpoint) {
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
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.type === "error") {
      handlers.reject(new Error(`${message.error}: ${message.message}`));
    } else handlers.resolve(message.result);
  });
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const close = async () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: nextId++, method: "session.end", params: {} }));
      await delay(100);
      socket.close();
    }
  };
  return { command, close };
}

async function main() {
  const bidi = await connectBidi(options.bidi);
  try {
    await bidi.command("session.new", { capabilities: { alwaysMatch: {} } });
    const tree = await bidi.command("browsingContext.getTree");
    const context = tree.contexts.find((item) => item.url?.includes("open.spotify.com"))?.context;
    if (!context) throw new Error("No Spotify tab found in isolated Firefox");

    const evaluate = async (expression) => {
      const response = await bidi.command("script.evaluate", {
        expression,
        target: { context },
        awaitPromise: false,
      });
      if (response.result?.type !== "string") {
        throw new Error(`Unexpected browser result: ${JSON.stringify(response).slice(0, 400)}`);
      }
      return JSON.parse(response.result.value);
    };

    const navigate = async (url) => {
      await bidi.command("browsingContext.navigate", { context, url, wait: "none" });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await evaluate(
          `JSON.stringify({ url: location.href, ready: document.readyState, title: document.title })`,
        );
        if (state.url.split("?")[0] === url && state.ready !== "loading") return;
        await delay(250);
      }
      throw new Error(`Timed out navigating to ${url}`);
    };

    await navigate(playlistsUrl);
    await delay(1500);
    const profileData = await evaluate(`JSON.stringify({
      displayName: document.title.replace(/^Spotify\\s*[–-]\\s*/, ''),
      playlists: [...document.querySelectorAll('a[href*="/playlist/"]')]
        .map((a) => ({ name: (a.innerText || a.getAttribute('aria-label') || '').trim(), url: a.href.split('?')[0] }))
        .filter((item) => item.name && !item.url.includes('/playlist/37i9dQZF'))
        .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    })`);

    const eligible = options.only
      ? profileData.playlists.filter((playlist) =>
          options.only.has(playlist.url.match(/\/playlist\/([^/?]+)/)?.[1]),
        )
      : profileData.playlists;
    const selected = options.limit ? eligible.slice(0, options.limit) : eligible;
    console.error(`Found ${profileData.playlists.length} public playlist links`);
    await mkdir(options.out, { recursive: true });

    const collected = [];
    for (const [index, playlist] of selected.entries()) {
      console.error(`[${index + 1}/${selected.length}] ${playlist.name}`);
      await navigate(playlist.url);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const ready = await evaluate(`JSON.stringify({
          rows: document.querySelectorAll('main [data-testid="tracklist-row"]').length,
          empty: document.body.innerText.includes('This playlist is empty')
        })`);
        if (ready.rows || ready.empty) break;
        await delay(250);
      }

      await evaluate(`JSON.stringify((() => {
        const root = document.querySelector('[data-testid="main-view-container"]') || document.body;
        const scroller = [root, ...root.querySelectorAll('*')]
          .filter((element) => getComputedStyle(element).overflowY === 'scroll')
          .filter((element) => element.scrollHeight > element.clientHeight + 100)
          .sort((a, b) => b.clientHeight - a.clientHeight)[0];
        if (scroller) scroller.scrollTop = 0;
        return { reset: Boolean(scroller) };
      })())`);
      await delay(500);

      const tracks = new Map();
      let stagnant = 0;
      let previousTop = -1;
      for (let pass = 0; pass < 350; pass += 1) {
        const state = await evaluate(`JSON.stringify((() => {
          const rows = [...document.querySelectorAll('main [data-testid="tracklist-row"]')].map((row) => {
            const track = row.querySelector('a[href*="/track/"]');
            const artistLinks = [...row.querySelectorAll('a[href*="/artist/"]')];
            const album = row.querySelector('a[href*="/album/"]');
            return {
              rowIndex: row.getAttribute('aria-rowindex'),
              id: track?.href.match(/\\/track\\/([^?]+)/)?.[1] || null,
              name: (track?.innerText || '').trim(),
              artists: artistLinks.map((a) => a.innerText.trim()).filter(Boolean),
              album: (album?.innerText || '').trim() || null,
              url: track?.href?.split('?')[0] || null,
              raw: row.innerText.trim()
            };
          });
          const root = document.querySelector('[data-testid="main-view-container"]') || document.body;
          const candidates = [root, ...root.querySelectorAll('*')]
            .filter((element) => getComputedStyle(element).overflowY === 'scroll')
            .filter((element) => element.scrollHeight > element.clientHeight + 100);
          const scroller = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
          const before = scroller?.scrollTop || 0;
          if (scroller) scroller.scrollTop = Math.min(
            scroller.scrollHeight,
            before + Math.max(300, scroller.clientHeight * 0.72)
          );
          return {
            rows,
            before,
            after: scroller?.scrollTop || 0,
            clientHeight: scroller?.clientHeight || 0,
            scrollHeight: scroller?.scrollHeight || 0
          };
        })())`);

        const priorSize = tracks.size;
        for (const track of state.rows) {
          const position = track.raw.split("\n", 1)[0];
          if (!/^\d+$/.test(position)) continue;
          tracks.set(position, { ...track, position: Number(position) });
        }
        stagnant = tracks.size === priorSize ? stagnant + 1 : 0;
        const bottom = state.after >= state.scrollHeight - state.clientHeight - 4;
        if ((bottom && stagnant >= 12) || (state.after === previousTop && stagnant >= 12)) break;
        previousTop = state.after;
        await delay(225);
      }

      const header = await evaluate(`JSON.stringify({
        name: (document.querySelector('main h1')?.innerText || '').trim(),
        text: (document.querySelector('main')?.innerText || '').slice(0, 2000)
      })`);
      const totalMatch = header.text.match(/([\d,]+) songs?/i);
      const declaredTrackCount = totalMatch ? Number(totalMatch[1].replaceAll(',', '')) : null;
      const playlistTracks = [...tracks.values()].filter(
        (track) => declaredTrackCount === null || track.position <= declaredTrackCount,
      );
      collected.push({
        ...playlist,
        name: header.name || playlist.name,
        declaredTrackCount,
        tracks: playlistTracks,
      });
      console.error(
        `  collected ${playlistTracks.length}${totalMatch ? ` / ${totalMatch[1]} declared` : ""} rows`,
      );
      await writeFile(
        path.join(options.out, "checkpoint.json"),
        `${JSON.stringify({ profile: profileData, playlists: collected }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }

    const occurrences = new Map();
    for (const playlist of collected) {
      const seen = new Set();
      for (const track of playlist.tracks) {
        const key = track.id || `${track.artists.join(", ")}\u0000${track.name}`.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const item = occurrences.get(key) || {
          id: track.id,
          name: track.name,
          artists: track.artists,
          url: track.url,
          playlists: [],
        };
        item.playlists.push({ name: playlist.name, url: playlist.url });
        occurrences.set(key, item);
      }
    }
    const repeatedTracks = [...occurrences.values()]
      .filter((track) => track.playlists.length > 1)
      .sort((a, b) => b.playlists.length - a.playlists.length || a.name.localeCompare(b.name));
    const result = {
      generatedAt: new Date().toISOString(),
      profile: { id: userId, displayName: profileData.displayName, url: profileUrl },
      discoveredPlaylistCount: profileData.playlists.length,
      collectedPlaylistCount: collected.length,
      playlistRows: collected.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
      uniqueTracks: occurrences.size,
      repeatedTracks,
      playlists: collected,
    };
    await writeFile(path.join(options.out, "snapshot.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        output: options.out,
        playlists: collected.length,
        playlistRows: result.playlistRows,
        uniqueTracks: result.uniqueTracks,
        repeatedTracks: repeatedTracks.length,
      }),
    );
  } finally {
    await bidi.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

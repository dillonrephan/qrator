#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [basePath, correctionsPath, outDir] = process.argv.slice(2);
if (!basePath || !correctionsPath || !outDir) {
  console.error(
    "Usage: finalize-spotify-overlap.mjs <base snapshot> <corrections snapshot> <output dir>",
  );
  process.exit(2);
}

const base = JSON.parse(await readFile(basePath, "utf8"));
const corrections = JSON.parse(await readFile(correctionsPath, "utf8"));
const correctionMap = new Map(corrections.playlists.map((playlist) => [playlist.url, playlist]));
const playlists = base.playlists.map((playlist) => correctionMap.get(playlist.url) || playlist);
const recentPlaylistCount = Math.min(24, playlists.length);

const occurrences = new Map();
for (const [playlistIndex, playlist] of playlists.entries()) {
  const seen = new Set();
  for (const track of playlist.tracks) {
    const artists = track.artists || [];
    const key = track.id || `${artists.join(", ")}\u0000${track.name}`.toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const item = occurrences.get(key) || {
      id: track.id,
      name: track.name,
      artists,
      album: track.album,
      url: track.url,
      playlists: [],
    };
    item.playlists.push({
      index: playlistIndex,
      name: playlist.name,
      url: playlist.url,
    });
    occurrences.set(key, item);
  }
}

for (const track of occurrences.values()) {
  track.recentCount = track.playlists.filter(
    (playlist) => playlist.index < recentPlaylistCount,
  ).length;
  track.archiveCount = track.playlists.length - track.recentCount;
  track.recentWeight = track.playlists.reduce(
    (sum, playlist) =>
      sum +
      (playlist.index < recentPlaylistCount
        ? (recentPlaylistCount - playlist.index) / recentPlaylistCount
        : 0),
    0,
  );
  track.rotationScore =
    track.recentCount * 10 + track.archiveCount * 1.5 + track.recentWeight;
}

const repeatedTracks = [...occurrences.values()]
  .filter((track) => track.playlists.length > 1)
  .sort(
    (a, b) =>
      b.rotationScore - a.rotationScore ||
      b.playlists.length - a.playlists.length ||
      a.name.localeCompare(b.name),
  );
const startHere = repeatedTracks.filter((track) => track.recentCount >= 2).slice(0, 100);

const playlistSets = playlists.map(
  (playlist) =>
    new Set(
      playlist.tracks.map(
        (track) =>
          track.id || `${(track.artists || []).join(", ")}\u0000${track.name}`.toLocaleLowerCase(),
      ),
    ),
);
const playlistPairs = [];
for (let left = 0; left < playlists.length; left += 1) {
  for (let right = left + 1; right < playlists.length; right += 1) {
    let intersection = 0;
    for (const key of playlistSets[left]) {
      if (playlistSets[right].has(key)) intersection += 1;
    }
    if (!intersection) continue;
    const smaller = Math.min(playlistSets[left].size, playlistSets[right].size);
    const union = playlistSets[left].size + playlistSets[right].size - intersection;
    playlistPairs.push({
      left: { index: left, name: playlists[left].name, url: playlists[left].url },
      right: { index: right, name: playlists[right].name, url: playlists[right].url },
      intersection,
      containment: smaller ? intersection / smaller : 0,
      jaccard: union ? intersection / union : 0,
    });
  }
}
playlistPairs.sort(
  (a, b) =>
    b.intersection - a.intersection ||
    b.containment - a.containment ||
    b.jaccard - a.jaccard,
);

const playlistRows = playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
const final = {
  generatedAt: new Date().toISOString(),
  profile: base.profile,
  method: {
    recentPlaylistCount,
    note: "Profile order is treated as a recency proxy, not a verified creation timestamp.",
  },
  playlistCount: playlists.length,
  playlistRows,
  uniqueTracks: occurrences.size,
  repeatedTrackCount: repeatedTracks.length,
  startHere,
  repeatedTracks,
  strongestPlaylistPairs: playlistPairs.slice(0, 100),
  playlists,
};

const trackLine = (track, index) => {
  const artists = track.artists.join(", ");
  const spotify = track.url ? ` — [Spotify](${track.url})` : "";
  const shelves = track.playlists
    .map((playlist) => playlist.name)
    .join(" · ");
  return `${index + 1}. **${artists} — ${track.name}** — ${track.recentCount} recent / ${track.playlists.length} total${spotify}\n   ${shelves}`;
};

const report = [
  `# Zay Spotify shelf overlap`,
  "",
  `- Public playlists compared: ${playlists.length}`,
  `- Playlist rows: ${playlistRows}`,
  `- Unique recordings: ${occurrences.size}`,
  `- Recordings repeated across playlists: ${repeatedTracks.length}`,
  `- Current-rotation proxy: the first ${recentPlaylistCount} playlists in profile order`,
  "",
  "Profile order is a useful but unverified recency proxy. Repetition identifies shelf staples; it does not prove a track was played live.",
  "",
  "## Start here: repeated in current-facing shelves",
  "",
  ...startHere.map(trackLine),
  "",
  "## Strongest playlist overlaps",
  "",
  ...playlistPairs.slice(0, 30).map(
    (pair, index) =>
      `${index + 1}. [${pair.left.name}](${pair.left.url}) ↔ [${pair.right.name}](${pair.right.url}) — ${pair.intersection} shared; ${(pair.containment * 100).toFixed(0)}% of the smaller shelf`,
  ),
  "",
].join("\n");

const startHereText = [
  "Zay shelf overlap — start here",
  "Exact recordings repeated across the first 24 profile playlists, ranked by recent and total shelf recurrence.",
  "",
  ...startHere.map(
    (track, index) =>
      `${index + 1}. ${track.artists.join(", ")} — ${track.name} | ${track.recentCount} recent / ${track.playlists.length} total | ${track.url || ""}`,
  ),
  "",
].join("\n");

await Promise.all([
  writeFile(path.join(outDir, "final-snapshot.json"), `${JSON.stringify(final, null, 2)}\n`, {
    mode: 0o600,
  }),
  writeFile(path.join(outDir, "overlap-report.md"), report, { mode: 0o600 }),
  writeFile(path.join(outDir, "start-here.txt"), startHereText, { mode: 0o600 }),
]);

console.log(
  JSON.stringify({
    playlists: playlists.length,
    playlistRows,
    uniqueTracks: occurrences.size,
    repeatedTracks: repeatedTracks.length,
    startHere: startHere.length,
  }),
);

#!/usr/bin/env node

import { chmod, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { analyzeAudioFiles, enumerateAudioDirectory } from '../src/audio-perception.js';

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  let files = parsed.files;
  let analysisOptions = {};
  if (parsed.command === 'analyze-tree') {
    if (files.length !== 1) throw new Error('analyze-tree needs exactly one explicit directory.');
    const tree = await enumerateAudioDirectory(files[0]);
    files = tree.files;
    analysisOptions = { inputMode: 'explicit-directory-tree', authorizedRoots: [tree.root] };
  }
  const evidence = await analyzeAudioFiles(files, analysisOptions);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (!parsed.output) {
    process.stdout.write(serialized);
    return;
  }
  const destination = path.resolve(parsed.output);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  process.stdout.write(`${JSON.stringify({
    output: destination,
    tracks: evidence.tracks.length,
    comparisons: evidence.comparisons.length,
    semantic_encoder: evidence.analysis.semantic_encoder,
  })}\n`);
}

function parseArguments(args) {
  const command = args[0];
  if (!['analyze', 'analyze-tree'].includes(command)) {
    throw new Error('Usage: qrator-audio <analyze|analyze-tree> [--output FILE] -- AUDIO_PATH...');
  }
  let output = null;
  const files = [];
  let positional = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!positional && argument === '--') {
      positional = true;
      continue;
    }
    if (!positional && argument === '--output') {
      output = args[index + 1];
      index += 1;
      if (!output) throw new Error('--output needs a file path.');
      continue;
    }
    if (!positional && argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    files.push(argument);
  }
  if (!files.length) throw new Error('Audio analysis needs at least one explicit file path.');
  return { command, output, files };
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message || 'Audio analysis failed.' })}\n`);
  process.exitCode = 2;
});

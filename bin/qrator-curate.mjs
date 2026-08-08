#!/usr/bin/env node

import { runCurationCommand } from '../src/agent-curation-command.js';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

async function main() {
  const input = await readBoundedStdin();
  const result = runCurationCommand(process.argv[2], input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function readBoundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Curation input exceeds the 2 MiB limit.');
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error('Curation input is empty.');
  return Buffer.concat(chunks).toString('utf8');
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message || 'Curation validation failed.' })}\n`);
  process.exitCode = 2;
});

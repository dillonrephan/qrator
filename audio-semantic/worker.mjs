#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { pipeline } from '@huggingface/transformers';

const execFileAsync = promisify(execFile);
const MODEL = 'Xenova/clap-htsat-unfused';
const REVISION = '7fe18129b081a8cd2a0aba45e858b5b114c03a6b';
const DESCRIPTOR_AXES = Object.freeze({
  energy_atmosphere: Object.freeze([
    'dark and driven music',
    'airy and ethereal music',
    'tense and aggressive music',
    'calm and reflective music',
  ]),
  production_texture: Object.freeze([
    'rough raw organic production',
    'clean polished production',
    'dusty lo-fi production',
    'distorted abrasive production',
  ]),
  rhythmic_family: Object.freeze([
    'underground hip hop with a boom bap groove',
    'chopped breakbeat or jungle music',
    'four on the floor electronic dance music',
    'unmetered ambient music without a strong beat',
  ]),
  density_space: Object.freeze([
    'a sparse minimal beat',
    'a dense layered beat',
    'spacious open music with room between sounds',
    'chaotic busy music with many competing sounds',
  ]),
  emotional_color: Object.freeze([
    'playful strange experimental music',
    'melancholy intimate music',
    'triumphant uplifting music',
    'ominous threatening music',
  ]),
});

function usage() {
  return [
    'Usage:',
    '  node audio-semantic/worker.mjs --evidence FILE --output FILE [--limit N] [--local-only]',
    '',
    'The worker reads only files already authorized in the evidence packet. It analyzes one',
    'deterministic 10-second peak-pressure excerpt per track, sequentially on CPU.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { limit: Infinity, localOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--evidence' || token === '--output' || token === '--limit') {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      parsed[token.slice(2)] = value;
      index += 1;
    } else if (token === '--local-only') {
      parsed.localOnly = true;
    } else if (token === '--help' || token === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (parsed.limit !== Infinity) {
    parsed.limit = Number.parseInt(parsed.limit, 10);
    if (!Number.isInteger(parsed.limit) || parsed.limit < 1) throw new Error('--limit must be a positive integer');
  }
  return parsed;
}

function sourcePath(track) {
  return typeof track.file === 'string' ? track.file : track.file?.path;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.evidence || !args.output) throw new Error(usage());

  const evidencePath = path.resolve(args.evidence);
  const outputPath = path.resolve(args.output);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (evidence.kind !== 'qrator-audio-evidence' || !Array.isArray(evidence.tracks)) {
    throw new Error('Input is not a QRator local audio evidence packet');
  }

  const cacheDir = path.resolve('audio-semantic/.cache');
  const classifier = await pipeline('zero-shot-audio-classification', MODEL, {
    revision: REVISION,
    dtype: 'q8',
    device: 'cpu',
    cache_dir: cacheDir,
    local_files_only: args.localOnly,
  });

  const scratch = await mkdtemp(path.join(tmpdir(), 'qrator-semantic-'));
  const tracks = [];
  try {
    for (const [index, track] of evidence.tracks.slice(0, args.limit).entries()) {
      const input = sourcePath(track);
      if (!path.isAbsolute(input)) throw new Error(`Authorized audio path is not absolute: ${input}`);
      const duration = track.measurements?.duration_seconds;
      const peak = track.structure?.peak_pressure_time_seconds ?? duration / 2;
      const start = Math.max(0, Math.min(Math.max(0, duration - 10), peak - 5));
      const excerpt = path.join(scratch, `${String(index).padStart(3, '0')}.f32le`);
      await execFileAsync('ffmpeg', [
        '-v', 'error', '-nostdin', '-ss', String(start), '-i', input,
        '-t', '10', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-c:a', 'pcm_f32le', '-y', excerpt,
      ], { timeout: 60_000, maxBuffer: 1024 * 1024 });

      const encoded = await readFile(excerpt);
      const audio = new Float32Array(encoded.byteLength / Float32Array.BYTES_PER_ELEMENT);
      for (let sample = 0; sample < audio.length; sample += 1) {
        audio[sample] = encoded.readFloatLE(sample * Float32Array.BYTES_PER_ELEMENT);
      }

      const axes = {};
      for (const [axis, labels] of Object.entries(DESCRIPTOR_AXES)) {
        const scores = await classifier(audio, labels, {
          hypothesis_template: 'This music sounds like {}.',
        });
        axes[axis] = [...scores]
          .sort((left, right) => right.score - left.score)
          .map(({ label, score }) => ({ label, score: Number(score.toFixed(6)) }));
      }
      tracks.push({
        audio_id: track.audio_id,
        title: path.basename(input),
        excerpt: { start_seconds: Number(start.toFixed(3)), duration_seconds: 10, selection: 'peak-pressure-centered' },
        axes,
      });
      console.error(`[${index + 1}/${Math.min(evidence.tracks.length, args.limit)}] ${path.basename(input)} -> ${Object.values(axes).map((scores) => scores[0].label).join(' | ')}`);
    }
  } finally {
    await classifier.dispose();
    await rm(scratch, { recursive: true, force: true });
  }

  const packet = {
    schema_version: 1,
    kind: 'qrator-local-audio-semantics',
    created_at: new Date().toISOString(),
    evidence_path: evidencePath,
    model: { id: MODEL, revision: REVISION, dtype: 'q8', device: 'cpu' },
    method: {
      excerpt_selection: 'one deterministic 10-second excerpt centered on measured peak pressure',
      descriptor_axes: DESCRIPTOR_AXES,
      interpretation: 'Each axis is normalized independently. Scores are relative only within that axis and excerpt; they are model judgments, not measured facts or human listening reports.',
    },
    boundary: {
      audio_uploaded: false,
      audio_network_access: false,
      model_download_may_use_network: !args.localOnly,
      durable_taste_inference: false,
    },
    tracks,
  };
  await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(JSON.stringify({ output: outputPath, tracks: tracks.length, model: MODEL }));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

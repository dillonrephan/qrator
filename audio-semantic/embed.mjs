#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AutoProcessor, ClapAudioModelWithProjection } from '@huggingface/transformers';

const execFileAsync = promisify(execFile);
const MODEL = 'Xenova/clap-htsat-unfused';
const REVISION = '7fe18129b081a8cd2a0aba45e858b5b114c03a6b';
const EXCERPT_SECONDS = 10;

function parseArgs(argv) {
  const parsed = { localOnly: false, limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--evidence' || token === '--output' || token === '--limit') {
      if (!argv[index + 1]) throw new Error(`Missing value for ${token}`);
      parsed[token.slice(2)] = argv[index + 1];
      index += 1;
    } else if (token === '--local-only') parsed.localOnly = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!parsed.evidence || !parsed.output) throw new Error('Usage: embed.mjs --evidence FILE --output FILE [--limit N] [--local-only]');
  if (parsed.limit !== Infinity) {
    parsed.limit = Number.parseInt(parsed.limit, 10);
    if (!Number.isInteger(parsed.limit) || parsed.limit < 1) throw new Error('--limit must be a positive integer');
  }
  return parsed;
}

function normalize(values) {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('Model returned a zero or invalid embedding');
  return values.map((value) => value / magnitude);
}

function cosine(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function excerptPlan(track) {
  const duration = track.measurements.duration_seconds;
  const lastStart = Math.max(0, duration - EXCERPT_SECONDS);
  const starts = [
    ['opening', 0],
    ['quarter', Math.max(0, duration * 0.25 - EXCERPT_SECONDS / 2)],
    ['peak-pressure', (track.structure.peak_pressure_time_seconds ?? duration / 2) - EXCERPT_SECONDS / 2],
    ['ending', lastStart],
  ];
  const seen = [];
  return starts.flatMap(([role, proposed]) => {
    const start = Math.max(0, Math.min(lastStart, proposed));
    if (seen.some((value) => Math.abs(value - start) < 1)) return [];
    seen.push(start);
    return [{ role, start_seconds: Number(start.toFixed(3)), duration_seconds: Math.min(EXCERPT_SECONDS, duration) }];
  });
}

function sourcePath(track) {
  return typeof track.file === 'string' ? track.file : track.file?.path;
}

async function decodeExcerpt(input, excerpt, destination) {
  await execFileAsync('ffmpeg', [
    '-v', 'error', '-nostdin', '-ss', String(excerpt.start_seconds), '-i', input,
    '-t', String(excerpt.duration_seconds), '-ac', '1', '-ar', '48000',
    '-f', 'f32le', '-c:a', 'pcm_f32le', '-y', destination,
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const encoded = await readFile(destination);
  const audio = new Float32Array(encoded.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let sample = 0; sample < audio.length; sample += 1) {
    audio[sample] = encoded.readFloatLE(sample * Float32Array.BYTES_PER_ELEMENT);
  }
  return audio;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidencePath = path.resolve(args.evidence);
  const outputPath = path.resolve(args.output);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (evidence.kind !== 'qrator-audio-evidence' || !Array.isArray(evidence.tracks)) throw new Error('Invalid QRator audio evidence packet');

  const modelOptions = {
    revision: REVISION,
    dtype: 'q8',
    device: 'cpu',
    cache_dir: path.resolve('audio-semantic/.cache'),
    local_files_only: args.localOnly,
  };
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL, modelOptions),
    ClapAudioModelWithProjection.from_pretrained(MODEL, modelOptions),
  ]);

  const scratch = await mkdtemp(path.join(tmpdir(), 'qrator-embed-'));
  const tracks = [];
  try {
    for (const [trackIndex, track] of evidence.tracks.slice(0, args.limit).entries()) {
      const input = sourcePath(track);
      if (!path.isAbsolute(input)) throw new Error(`Authorized audio path is not absolute: ${input}`);
      const excerpts = [];
      for (const [excerptIndex, excerpt] of excerptPlan(track).entries()) {
        const rawPath = path.join(scratch, `${trackIndex}-${excerptIndex}.f32le`);
        const audio = await decodeExcerpt(input, excerpt, rawPath);
        const inputs = await processor(audio);
        const { audio_embeds: tensor } = await model(inputs);
        excerpts.push({ ...excerpt, embedding: normalize(Array.from(tensor.data)).map((value) => Number(value.toFixed(7))) });
      }
      const mean = Array.from({ length: excerpts[0].embedding.length }, (_, dimension) => (
        excerpts.reduce((sum, excerpt) => sum + excerpt.embedding[dimension], 0) / excerpts.length
      ));
      tracks.push({
        audio_id: track.audio_id,
        title: path.basename(input),
        aggregate_embedding: normalize(mean).map((value) => Number(value.toFixed(7))),
        excerpts,
      });
      console.error(`[${trackIndex + 1}/${Math.min(evidence.tracks.length, args.limit)}] ${path.basename(input)} (${excerpts.length} excerpts)`);
    }
  } finally {
    await model.dispose();
    await rm(scratch, { recursive: true, force: true });
  }

  const pairs = [];
  for (let left = 0; left < tracks.length; left += 1) {
    for (let right = left + 1; right < tracks.length; right += 1) {
      pairs.push({
        left_audio_id: tracks[left].audio_id,
        left_title: tracks[left].title,
        right_audio_id: tracks[right].audio_id,
        right_title: tracks[right].title,
        cosine_similarity: Number(cosine(tracks[left].aggregate_embedding, tracks[right].aggregate_embedding).toFixed(7)),
      });
    }
  }
  pairs.sort((left, right) => right.cosine_similarity - left.cosine_similarity);

  const packet = {
    schema_version: 1,
    kind: 'qrator-local-audio-embeddings',
    created_at: new Date().toISOString(),
    evidence_path: evidencePath,
    model: { id: MODEL, revision: REVISION, component: 'ClapAudioModelWithProjection', dtype: 'q8', device: 'cpu', dimensions: 512 },
    method: {
      excerpts: ['opening', 'quarter', 'peak-pressure', 'ending'],
      excerpt_seconds: EXCERPT_SECONDS,
      aggregation: 'L2-normalized arithmetic mean of L2-normalized excerpt embeddings',
      interpretation: 'Cosine similarity is model-relative acoustic proximity, not a taste score or proof of shared genre.',
    },
    boundary: { audio_uploaded: false, audio_network_access: false, model_download_may_use_network: !args.localOnly, durable_taste_inference: false },
    tracks,
    pairs,
  };
  await writeFile(outputPath, `${JSON.stringify(packet)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(JSON.stringify({ output: outputPath, tracks: tracks.length, pairs: pairs.length, dimensions: 512 }));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

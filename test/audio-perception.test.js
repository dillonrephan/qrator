import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ANALYSIS_SAMPLE_RATE,
  MAX_AUDIO_FILES,
  analyzeAudioFile,
  analyzeAudioFiles,
  analyzePcm,
  compareAudioTracks,
  enumerateAudioDirectory,
} from '../src/audio-perception.js';

function sine(frequency, seconds = 3, amplitude = 0.3) {
  const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * seconds);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / ANALYSIS_SAMPLE_RATE);
  }
  return samples;
}

function pulseTrain(bpm, seconds = 20) {
  const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * seconds);
  const beatSamples = (ANALYSIS_SAMPLE_RATE * 60) / bpm;
  for (let start = 0; start < samples.length; start += beatSamples) {
    for (let offset = 0; offset < ANALYSIS_SAMPLE_RATE * 0.04 && start + offset < samples.length; offset += 1) {
      samples[Math.floor(start + offset)] = 0.8 * Math.exp(-offset / (ANALYSIS_SAMPLE_RATE * 0.01)) * (offset % 2 ? 1 : -1);
    }
  }
  return samples;
}

function risingNoise(seconds = 24) {
  const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * seconds);
  let state = 0x12345678;
  for (let index = 0; index < samples.length; index += 1) {
    state = ((state * 1664525) + 1013904223) >>> 0;
    const noise = ((state / 0xffffffff) * 2) - 1;
    const gain = 0.015 + (0.6 * index / samples.length);
    samples[index] = noise * gain;
  }
  return samples;
}

test('waveform analysis distinguishes dark and bright steady signals without inventing onsets', () => {
  const dark = analyzePcm(sine(100));
  const bright = analyzePcm(sine(3_000));
  assert.ok(dark.measurements.spectral_centroid_hz < 120);
  assert.ok(bright.measurements.spectral_centroid_hz > 2_900);
  assert.equal(dark.measurements.onset_rate_per_second, 0);
  assert.equal(bright.measurements.onset_rate_per_second, 0);
  assert.ok(dark.observations.some((item) => item.code === 'dark-spectrum'));
  assert.ok(bright.observations.some((item) => item.code === 'bright-spectrum'));
  assert.equal(dark.structure.pressure_arc.direction, 'level');
});

test('tempo and structural evidence recover controlled pulse and pressure canaries', () => {
  const pulse = analyzePcm(pulseTrain(120));
  assert.ok(pulse.measurements.tempo_bpm >= 117 && pulse.measurements.tempo_bpm <= 123);
  assert.ok(pulse.measurements.tempo_confidence > 0.5);
  assert.ok(pulse.measurements.onset_rate_per_second > 1.5);

  const rising = analyzePcm(risingNoise());
  assert.equal(rising.structure.pressure_arc.direction, 'rises');
  assert.ok(rising.measurements.pressure_spread > 0.08);
  assert.ok(rising.measurements.tempo_confidence < 0.35);
});

test('pairwise comparison ranks genuinely similar waveforms first', () => {
  const track = (id, title, samples) => ({
    audio_id: id,
    file: { basename: title },
    ...analyzePcm(samples),
  });
  const comparisons = compareAudioTracks([
    track('low-a', 'low-a.wav', sine(100)),
    track('low-b', 'low-b.wav', sine(120)),
    track('high', 'high.wav', sine(3_000)),
  ]);
  assert.equal(comparisons[0].left_audio_id, 'low-a');
  assert.equal(comparisons[0].right_audio_id, 'low-b');
  assert.ok(comparisons[0].batch_relative_similarity > comparisons.at(-1).batch_relative_similarity);
});

test('file analysis is explicit, hashed, local-only, and bounded', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qrator-audio-test-'));
  const audioPath = path.join(directory, 'explicit.wav');
  await writeFile(audioPath, 'synthetic fixture');
  const pcm = Buffer.from(sine(440, 4).buffer);
  const runFile = async (command) => {
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify({
          streams: [{ codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 }],
          format: { duration: '4' },
        }),
      };
    }
    if (command === 'ffmpeg') return { stdout: pcm };
    throw new Error(`unexpected command: ${command}`);
  };
  try {
    const track = await analyzeAudioFile(audioPath, { runFile });
    assert.match(track.audio_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(track.file.path, audioPath);
    assert.equal(track.file.codec, 'pcm_s16le');
    const document = await analyzeAudioFiles([audioPath], { runFile });
    assert.equal(document.boundary.input_mode, 'explicit-files-only');
    assert.equal(document.boundary.network_used, false);
    assert.equal(document.boundary.audio_uploaded, false);
    assert.equal(document.memory.durable_taste_inference, false);
    await assert.rejects(() => analyzeAudioFiles([], { runFile }), /at least one explicit file/);
    await assert.rejects(
      () => analyzeAudioFiles(new Array(MAX_AUDIO_FILES + 1).fill(audioPath), { runFile }),
      /at most 128/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded tree expansion accepts supported files and refuses symlink traversal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qrator-tree-test-'));
  const nested = path.join(directory, 'nested');
  const { mkdir, symlink } = await import('node:fs/promises');
  await mkdir(nested);
  await writeFile(path.join(directory, 'first.wav'), 'one');
  await writeFile(path.join(nested, 'second.FLAC'), 'two');
  await writeFile(path.join(nested, 'notes.txt'), 'ignored');
  try {
    const tree = await enumerateAudioDirectory(directory);
    assert.equal(tree.root, directory);
    assert.deepEqual(tree.files.map((file) => path.basename(file)).sort(), ['first.wav', 'second.FLAC']);
    await symlink(path.join(directory, 'first.wav'), path.join(nested, 'alias.wav'));
    await assert.rejects(() => enumerateAudioDirectory(directory), /symbolic link/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

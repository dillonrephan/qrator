import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const runFile = promisify(execFile);

export const ANALYSIS_SAMPLE_RATE = 12_000;
export const MAX_AUDIO_FILES = 128;
export const MAX_AUDIO_SECONDS = 30 * 60;
export const MAX_AUDIO_FILE_BYTES = 4 * 1024 * 1024 * 1024;

const EPSILON = 1e-12;
const SPECTRAL_FRAME = 2_048;
const SPECTRAL_HOP = 2_048;
const ENVELOPE_FRAME = 2_048;
const ENVELOPE_HOP = 256;
const SEGMENT_SECONDS = 8;
const AUDIO_EXTENSIONS = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.wma']);

export async function analyzeAudioFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || !filePaths.length) {
    throw new TypeError('Audio analysis needs at least one explicit file path.');
  }
  if (filePaths.length > MAX_AUDIO_FILES) {
    throw new TypeError(`Audio analysis accepts at most ${MAX_AUDIO_FILES} explicit files.`);
  }

  const tracks = [];
  for (const filePath of filePaths) {
    tracks.push(await analyzeAudioFile(filePath, options));
  }
  return {
    schema_version: 1,
    kind: 'qrator-audio-evidence',
    created_at: new Date().toISOString(),
    memory: {
      mode: 'ephemeral',
      durable_taste_inference: false,
    },
    boundary: {
      input_mode: options.inputMode || 'explicit-files-only',
      authorized_roots: options.authorizedRoots || [],
      unbounded_recursive_discovery: false,
      bounded_directory_expansion: options.inputMode === 'explicit-directory-tree',
      network_used: false,
      audio_uploaded: false,
    },
    analysis: {
      decoder: 'ffmpeg',
      sample_rate_hz: ANALYSIS_SAMPLE_RATE,
      channel_layout: 'mono',
      semantic_encoder: options.semanticEncoder || null,
      interpretation: 'Measurements are deterministic DSP evidence; observations are labeled heuristics.',
    },
    tracks,
    comparisons: compareAudioTracks(tracks),
  };
}

export async function enumerateAudioDirectory(directoryPath, options = {}) {
  const root = path.resolve(String(directoryPath || ''));
  const maximumDepth = Number.isInteger(options.maximumDepth) ? options.maximumDepth : 8;
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new TypeError(`Audio tree root must be a real directory: ${root}`);
  }
  const files = [];
  async function visit(directory, depth) {
    if (depth > maximumDepth) throw new TypeError(`Audio tree exceeds depth ${maximumDepth}: ${directory}`);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError(`Audio tree contains a symbolic link: ${candidate}`);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(candidate);
      if (files.length > MAX_AUDIO_FILES) {
        throw new TypeError(`Audio tree contains more than ${MAX_AUDIO_FILES} supported files.`);
      }
    }
  }
  await visit(root, 0);
  if (!files.length) throw new TypeError(`Audio tree contains no supported files: ${root}`);
  return { root, files };
}

export async function analyzeAudioFile(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ''));
  const entry = await lstat(resolved);
  if (entry.isSymbolicLink() && options.allowSymlinks !== true) {
    throw new TypeError(`Audio input must not be a symbolic link: ${resolved}`);
  }
  const details = await stat(resolved);
  if (!details.isFile()) throw new TypeError(`Audio input is not a regular file: ${resolved}`);
  if (details.size > MAX_AUDIO_FILE_BYTES) throw new TypeError(`Audio input exceeds 4 GiB: ${resolved}`);

  const probe = await probeAudioFile(resolved, options);
  if (!Number.isFinite(probe.duration_seconds) || probe.duration_seconds <= 0) {
    throw new TypeError(`Audio input has no usable duration: ${resolved}`);
  }
  if (probe.duration_seconds > MAX_AUDIO_SECONDS) {
    throw new TypeError(`Audio input exceeds the 30 minute analysis limit: ${resolved}`);
  }

  const samples = await decodeAudioFile(resolved, probe, options);
  const evidence = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
  const sha256 = await sha256File(resolved);
  return {
    audio_id: `sha256:${sha256}`,
    file: {
      path: resolved,
      basename: path.basename(resolved),
      byte_length: details.size,
      sha256,
      codec: probe.codec,
      source_sample_rate_hz: probe.sample_rate_hz,
      source_channels: probe.channels,
      duration_seconds: rounded(probe.duration_seconds, 3),
    },
    ...evidence,
  };
}

export function analyzePcm(inputSamples, sampleRate = ANALYSIS_SAMPLE_RATE) {
  const samples = inputSamples instanceof Float32Array ? inputSamples : Float32Array.from(inputSamples || []);
  if (!samples.length) throw new TypeError('PCM analysis needs at least one sample.');
  if (!Number.isFinite(sampleRate) || sampleRate < 2_000) throw new TypeError('PCM sample rate is invalid.');

  const envelope = energyEnvelope(samples, sampleRate);
  const tempo = estimateTempo(envelope.onsets, envelope.rate_hz);
  const spectralFrames = spectralEvidence(samples, sampleRate);
  const segmentFrames = segmentEvidence(samples, sampleRate, envelope, spectralFrames);
  const rmsDbValues = envelope.rms_db.filter(Number.isFinite);
  const activeSpectralFrames = spectralFrames.filter((frame) => frame.total_energy > EPSILON);
  const centroidValues = activeSpectralFrames.map((frame) => frame.centroid_hz);
  const rolloffValues = activeSpectralFrames.map((frame) => frame.rolloff_85_hz);
  const lowValues = activeSpectralFrames.map((frame) => frame.low_energy_ratio);
  const midValues = activeSpectralFrames.map((frame) => frame.mid_energy_ratio);
  const highValues = activeSpectralFrames.map((frame) => frame.high_energy_ratio);
  const onsetPeaks = detectedOnsetPeaks(envelope.onsets);
  const duration = samples.length / sampleRate;
  const measurements = {
    duration_seconds: rounded(duration, 3),
    integrated_rms_dbfs: rounded(amplitudeToDb(rootMeanSquare(samples)), 3),
    decoded_mono_peak_dbfs: rounded(amplitudeToDb(peakAmplitude(samples)), 3),
    loudness_spread_db: rounded(percentile(rmsDbValues, 0.9) - percentile(rmsDbValues, 0.1), 3),
    tempo_bpm: rounded(tempo.bpm, 2),
    tempo_confidence: rounded(tempo.confidence, 4),
    alternate_tempo_bpm: tempo.alternate_bpm ? rounded(tempo.alternate_bpm, 2) : null,
    onset_rate_per_second: rounded(onsetPeaks.length / duration, 4),
    onset_strength_mean: rounded(mean(envelope.onsets), 6),
    spectral_centroid_hz: rounded(mean(centroidValues), 2),
    spectral_rolloff_85_hz: rounded(mean(rolloffValues), 2),
    low_energy_ratio: rounded(mean(lowValues), 5),
    mid_energy_ratio: rounded(mean(midValues), 5),
    high_energy_ratio: rounded(mean(highValues), 5),
    zero_crossing_rate: rounded(zeroCrossingRate(samples), 6),
    pressure_mean: rounded(mean(segmentFrames.map((segment) => segment.pressure)), 4),
    pressure_spread: rounded(
      percentile(segmentFrames.map((segment) => segment.pressure), 0.9)
        - percentile(segmentFrames.map((segment) => segment.pressure), 0.1),
      4,
    ),
  };

  return {
    measurements,
    structure: structuralSummary(segmentFrames),
    segments: segmentFrames,
    observations: heuristicObservations(measurements, segmentFrames),
  };
}

export function compareAudioTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2) return [];
  const featureNames = [
    'tempo_bpm',
    'onset_rate_per_second',
    'spectral_centroid_hz',
    'low_energy_ratio',
    'loudness_spread_db',
    'pressure_mean',
    'pressure_spread',
  ];
  const columns = Object.fromEntries(featureNames.map((name) => [
    name,
    tracks.map((track) => Number(track.measurements?.[name]) || 0),
  ]));
  const scales = Object.fromEntries(featureNames.map((name) => {
    const values = columns[name];
    return [name, { mean: mean(values), spread: standardDeviation(values) || 1 }];
  }));
  const comparisons = [];
  for (let left = 0; left < tracks.length; left += 1) {
    for (let right = left + 1; right < tracks.length; right += 1) {
      let squared = 0;
      const deltas = {};
      for (const name of featureNames) {
        const delta = (columns[name][left] - columns[name][right]) / scales[name].spread;
        squared += delta * delta;
        deltas[name] = rounded(Math.abs(delta), 4);
      }
      const distance = Math.sqrt(squared / featureNames.length);
      const leftCodes = new Set((tracks[left].observations || []).map((item) => item.code));
      const shared = (tracks[right].observations || [])
        .map((item) => item.code)
        .filter((code) => leftCodes.has(code));
      comparisons.push({
        left_audio_id: tracks[left].audio_id || `track:${left}`,
        right_audio_id: tracks[right].audio_id || `track:${right}`,
        left_title: tracks[left].file?.basename || `track ${left + 1}`,
        right_title: tracks[right].file?.basename || `track ${right + 1}`,
        distance: rounded(distance, 4),
        batch_relative_similarity: rounded(Math.exp(-distance), 4),
        shared_observation_codes: shared,
        normalized_feature_deltas: deltas,
      });
    }
  }
  return comparisons.sort((a, b) => a.distance - b.distance);
}

async function probeAudioFile(filePath, options) {
  const run = options.runFile || runFile;
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
    '-of', 'json',
    filePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const document = JSON.parse(stdout);
  const stream = document.streams?.[0] || {};
  return {
    codec: String(stream.codec_name || ''),
    sample_rate_hz: Number(stream.sample_rate) || null,
    channels: Number(stream.channels) || null,
    duration_seconds: Number(document.format?.duration),
  };
}

async function decodeAudioFile(filePath, probe, options) {
  const run = options.runFile || runFile;
  const duration = probe.duration_seconds;
  const expectedBytes = Math.ceil(duration * ANALYSIS_SAMPLE_RATE * 4);
  const decodeArguments = ['-nostdin', '-v', 'error', '-i', filePath, '-map', '0:a:0'];
  if (probe.channels === 2) decodeArguments.push('-af', 'pan=mono|c0=0.5*c0+0.5*c1');
  else decodeArguments.push('-ac', '1');
  decodeArguments.push('-ar', String(ANALYSIS_SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
  const { stdout } = await run('ffmpeg', decodeArguments, {
    encoding: 'buffer',
    timeout: Math.max(30_000, Math.min(180_000, Math.ceil(duration * 250))),
    maxBuffer: Math.max(16 * 1024 * 1024, expectedBytes + 1024 * 1024),
  });
  const usableBytes = stdout.byteLength - (stdout.byteLength % 4);
  const copy = Buffer.from(stdout.subarray(0, usableBytes));
  return new Float32Array(copy.buffer, copy.byteOffset, usableBytes / 4).slice();
}

function energyEnvelope(samples, sampleRate) {
  const rms = [];
  const rmsDb = [];
  for (let start = 0; start + ENVELOPE_FRAME <= samples.length; start += ENVELOPE_HOP) {
    let energy = 0;
    for (let index = start; index < start + ENVELOPE_FRAME; index += 1) {
      energy += samples[index] * samples[index];
    }
    const value = Math.sqrt(energy / ENVELOPE_FRAME);
    rms.push(value);
    rmsDb.push(amplitudeToDb(value));
  }
  const logEnergy = rms.map((value) => Math.log(value + EPSILON));
  const onsets = new Array(logEnergy.length).fill(0);
  for (let index = 1; index < logEnergy.length; index += 1) {
    onsets[index] = Math.max(0, logEnergy[index] - mean(logEnergy.slice(Math.max(0, index - 3), index)));
  }
  return { rms, rms_db: rmsDb, onsets, rate_hz: sampleRate / ENVELOPE_HOP };
}

function estimateTempo(onsets, envelopeRate) {
  if (onsets.length < envelopeRate * 4) return { bpm: 0, confidence: 0, alternate_bpm: null };
  const localRadius = Math.max(2, Math.round(envelopeRate * 2));
  const normalized = onsets.map((value, index) => {
    const neighborhood = onsets.slice(Math.max(0, index - localRadius), Math.min(onsets.length, index + localRadius + 1));
    const localScale = Math.sqrt(mean(neighborhood.map((entry) => entry * entry))) + EPSILON;
    return value / localScale;
  });
  const centered = normalized.map((value) => value - mean(normalized));
  const minimumLag = Math.max(1, Math.ceil((envelopeRate * 60) / 200));
  const maximumLag = Math.min(centered.length - 2, Math.floor((envelopeRate * 60) / 70));
  const correlations = [];
  let best = { lag: 0, value: -Infinity };
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let numerator = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = lag; index < centered.length; index += 1) {
      const left = centered[index];
      const right = centered[index - lag];
      numerator += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const value = numerator / Math.sqrt(leftEnergy * rightEnergy + EPSILON);
    correlations.push({ lag, value });
    if (value > best.value) best = { lag, value };
  }
  if (!best.lag || !Number.isFinite(best.value)) return { bpm: 0, confidence: 0, alternate_bpm: null };
  const shorterNearPeak = correlations
    .filter((entry) => entry.lag < best.lag && entry.value >= best.value * 0.92)
    .sort((a, b) => a.lag - b.lag)[0];
  if (shorterNearPeak) best = shorterNearPeak;
  const bpm = (60 * envelopeRate) / best.lag;
  const alternative = correlations
    .filter((entry) => Math.abs(entry.lag - best.lag) > 2)
    .sort((a, b) => b.value - a.value)[0];
  const background = percentile(correlations.map((entry) => entry.value), 0.5);
  const confidence = clamp((best.value - background) / Math.max(EPSILON, 1 - background), 0, 1);
  return {
    bpm,
    confidence,
    alternate_bpm: alternative?.value > best.value * 0.85 ? (60 * envelopeRate) / alternative.lag : null,
  };
}

function spectralEvidence(samples, sampleRate) {
  const frames = [];
  const window = hannWindow(SPECTRAL_FRAME);
  for (let start = 0; start + SPECTRAL_FRAME <= samples.length; start += SPECTRAL_HOP) {
    const real = new Float64Array(SPECTRAL_FRAME);
    const imaginary = new Float64Array(SPECTRAL_FRAME);
    for (let index = 0; index < SPECTRAL_FRAME; index += 1) real[index] = samples[start + index] * window[index];
    fft(real, imaginary);
    const bins = SPECTRAL_FRAME / 2;
    const power = new Float64Array(bins);
    let total = 0;
    for (let bin = 1; bin < bins; bin += 1) {
      power[bin] = (real[bin] * real[bin]) + (imaginary[bin] * imaginary[bin]);
      total += power[bin];
    }
    let weighted = 0;
    let cumulative = 0;
    let rolloff = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let bin = 1; bin < bins; bin += 1) {
      const frequency = (bin * sampleRate) / SPECTRAL_FRAME;
      const value = power[bin];
      weighted += frequency * value;
      cumulative += value;
      if (!rolloff && cumulative >= total * 0.85) rolloff = frequency;
      if (frequency < 180) low += value;
      else if (frequency < 2_000) mid += value;
      else high += value;
    }
    frames.push({
      time_seconds: start / sampleRate,
      total_energy: total,
      centroid_hz: total ? weighted / total : 0,
      rolloff_85_hz: rolloff,
      low_energy_ratio: low / (total + EPSILON),
      mid_energy_ratio: mid / (total + EPSILON),
      high_energy_ratio: high / (total + EPSILON),
    });
  }
  return frames.length ? frames : [{
    time_seconds: 0,
    total_energy: 0,
    centroid_hz: 0,
    rolloff_85_hz: 0,
    low_energy_ratio: 0,
    mid_energy_ratio: 0,
    high_energy_ratio: 0,
  }];
}

function segmentEvidence(samples, sampleRate, envelope, spectralFrames) {
  const duration = samples.length / sampleRate;
  const segmentCount = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));
  const onsetCeiling = percentile(envelope.onsets, 0.95) || 1;
  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const startSeconds = index * SEGMENT_SECONDS;
    const endSeconds = Math.min(duration, (index + 1) * SEGMENT_SECONDS);
    const firstSample = Math.floor(startSeconds * sampleRate);
    const lastSample = Math.max(firstSample + 1, Math.floor(endSeconds * sampleRate));
    const segmentSamples = samples.subarray(firstSample, lastSample);
    const firstEnvelope = Math.floor(startSeconds * envelope.rate_hz);
    const lastEnvelope = Math.max(firstEnvelope + 1, Math.ceil(endSeconds * envelope.rate_hz));
    const segmentOnsets = envelope.onsets.slice(firstEnvelope, lastEnvelope);
    const spectra = spectralFrames.filter((frame) => (
      frame.time_seconds >= startSeconds && frame.time_seconds < endSeconds && frame.total_energy > EPSILON
    ));
    const rmsDb = amplitudeToDb(rootMeanSquare(segmentSamples));
    const onsetStrength = mean(segmentOnsets) / onsetCeiling;
    const lowRatio = mean(spectra.map((frame) => frame.low_energy_ratio));
    const loudnessUnit = clamp((rmsDb + 36) / 30, 0, 1);
    const pressure = clamp((0.55 * loudnessUnit) + (0.25 * clamp(onsetStrength, 0, 1)) + (0.2 * lowRatio), 0, 1);
    segments.push({
      index,
      start_seconds: rounded(startSeconds, 3),
      end_seconds: rounded(endSeconds, 3),
      rms_dbfs: rounded(rmsDb, 3),
      spectral_centroid_hz: rounded(mean(spectra.map((frame) => frame.centroid_hz)), 2),
      low_energy_ratio: rounded(lowRatio, 5),
      onset_strength_relative: rounded(onsetStrength, 5),
      pressure: rounded(pressure, 4),
    });
  }
  return segments;
}

function structuralSummary(segments) {
  const pressures = segments.map((segment) => segment.pressure);
  const loudness = segments.map((segment) => segment.rms_dbfs);
  const peakIndex = indexOfMaximum(pressures);
  const thirds = thirdMeans(pressures);
  return {
    segment_seconds: SEGMENT_SECONDS,
    segment_count: segments.length,
    peak_pressure_segment: peakIndex,
    peak_pressure_time_seconds: segments[peakIndex]?.start_seconds || 0,
    pressure_arc: {
      opening: rounded(thirds[0], 4),
      middle: rounded(thirds[1], 4),
      ending: rounded(thirds[2], 4),
      direction: arcDirection(thirds),
    },
    quietest_segment: indexOfMinimum(loudness),
    loudest_segment: indexOfMaximum(loudness),
  };
}

function heuristicObservations(measurements, segments) {
  const observations = [];
  const add = (code, label, evidence) => observations.push({ code, label, evidence, basis: 'heuristic-from-measurements' });
  if (measurements.tempo_confidence >= 0.08 && measurements.tempo_bpm >= 80) {
    add('pulse-candidate', 'Periodic energy supports a tempo candidate; this is not a beat-grid guarantee.', ['tempo_bpm', 'tempo_confidence']);
  }
  if (measurements.onset_rate_per_second >= 1.5) {
    add('transient-dense', 'Frequent energy attacks suggest dense rhythmic or percussive activity.', ['onset_rate_per_second']);
  } else if (measurements.onset_rate_per_second <= 0.55) {
    add('transient-sparse', 'Energy attacks are relatively sparse.', ['onset_rate_per_second']);
  }
  if (measurements.low_energy_ratio >= 0.18) {
    add('low-end-weighted', 'A substantial share of measured spectral energy sits below 180 Hz.', ['low_energy_ratio']);
  }
  if (measurements.spectral_centroid_hz < 1_350) {
    add('dark-spectrum', 'The average spectral center is comparatively low.', ['spectral_centroid_hz']);
  } else if (measurements.spectral_centroid_hz > 2_250) {
    add('bright-spectrum', 'The average spectral center is comparatively high.', ['spectral_centroid_hz']);
  }
  if (measurements.loudness_spread_db >= 10) {
    add('wide-dynamics', 'Segment loudness varies substantially across the recording.', ['loudness_spread_db']);
  }
  if (measurements.pressure_spread >= 0.16) {
    add('pressure-arc', 'Measured pressure changes materially across the recording.', ['pressure_spread', 'segments']);
  }
  const direction = structuralSummary(segments).pressure_arc.direction;
  if (direction !== 'level') add(`pressure-${direction}`, `Measured pressure ${direction.replace('-', ' ')} across broad sections.`, ['structure.pressure_arc']);
  return observations;
}

function detectedOnsetPeaks(onsets) {
  if (onsets.length < 3) return [];
  const threshold = Math.max(0.02, percentile(onsets, 0.85), mean(onsets) + (1.25 * standardDeviation(onsets)));
  const peaks = [];
  for (let index = 1; index < onsets.length - 1; index += 1) {
    if (onsets[index] >= threshold && onsets[index] > onsets[index - 1] && onsets[index] >= onsets[index + 1]) {
      if (!peaks.length || index - peaks.at(-1) >= 3) peaks.push(index);
    }
  }
  return peaks;
}

function fft(real, imaginary) {
  const size = real.length;
  for (let index = 1, bit = 0; index < size; index += 1) {
    let mask = size >> 1;
    for (; bit & mask; mask >>= 1) bit ^= mask;
    bit ^= mask;
    if (index < bit) {
      [real[index], real[bit]] = [real[bit], real[index]];
      [imaginary[index], imaginary[bit]] = [imaginary[bit], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const baseReal = Math.cos(angle);
    const baseImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + (length / 2);
        const oddReal = (real[odd] * rotationReal) - (imaginary[odd] * rotationImaginary);
        const oddImaginary = (real[odd] * rotationImaginary) + (imaginary[odd] * rotationReal);
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = (rotationReal * baseReal) - (rotationImaginary * baseImaginary);
        rotationImaginary = (rotationReal * baseImaginary) + (rotationImaginary * baseReal);
        rotationReal = nextReal;
      }
    }
  }
}

function hannWindow(size) {
  return Float64Array.from({ length: size }, (_, index) => 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1))));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function peakAmplitude(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

function rootMeanSquare(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function zeroCrossingRate(samples) {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1] < 0 && samples[index] >= 0) || (samples[index - 1] >= 0 && samples[index] < 0)) crossings += 1;
  }
  return crossings / (samples.length - 1);
}

function amplitudeToDb(value) {
  return 20 * Math.log10(Math.max(1e-6, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function percentile(values, position) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * clamp(position, 0, 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function thirdMeans(values) {
  if (!values.length) return [0, 0, 0];
  if (values.length === 1) return [values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], mean(values), values[1]];
  const firstEnd = Math.max(1, Math.ceil(values.length / 3));
  const secondEnd = Math.max(firstEnd + 1, Math.ceil((values.length * 2) / 3));
  return [mean(values.slice(0, firstEnd)), mean(values.slice(firstEnd, secondEnd)), mean(values.slice(secondEnd))];
}

function arcDirection([opening, middle, ending]) {
  const threshold = 0.06;
  if (ending - opening >= threshold) return middle > Math.max(opening, ending) + threshold ? 'peaks-middle' : 'rises';
  if (opening - ending >= threshold) return middle < Math.min(opening, ending) - threshold ? 'dips-middle' : 'falls';
  if (middle > Math.max(opening, ending) + threshold) return 'peaks-middle';
  if (middle < Math.min(opening, ending) - threshold) return 'dips-middle';
  return 'level';
}

function indexOfMaximum(values) {
  return values.reduce((best, value, index) => (value > values[best] ? index : best), 0);
}

function indexOfMinimum(values) {
  return values.reduce((best, value, index) => (value < values[best] ? index : best), 0);
}

function rounded(value, places) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

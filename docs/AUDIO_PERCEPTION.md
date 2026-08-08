# Local audio perception

QRator can inspect explicitly authorized local audio instead of treating a filename or provider listing as the recording itself. The system deliberately keeps three kinds of claim separate:

1. **Measured evidence** — deterministic waveform measurements such as spectral balance, transient density, candidate pulse, dynamics, and pressure over time.
2. **Heuristic observations** — clearly labeled interpretations derived from those measurements, such as `low-end-weighted` or `pressure-peaks-middle`.
3. **Semantic model judgments** — CLAP comparisons between a fixed vocabulary and one declared excerpt. These are relative model scores, not objective tags or a claim that QRator hears exactly as a person does.

No audio is uploaded. The deterministic analyzer performs no network access. The optional semantic worker downloads a pinned model once, then inference occurs locally on CPU.

## Commands

Analyze explicit files:

```sh
npm run audio:analyze -- --output output/evidence.json -- /absolute/track-one.wav /absolute/track-two.wav
```

Analyze one explicitly authorized directory tree:

```sh
npm run audio:analyze-tree -- --output output/evidence.json -- /absolute/authorized-directory
```

The tree walk is deterministic, refuses symbolic links, accepts supported audio extensions only, stops at a bounded depth, and is capped at 128 files. It never treats a parent directory as implicitly authorized.

Add semantic judgments:

```sh
npm run audio:semantic -- --evidence output/evidence.json --output output/semantics.json
```

Build multi-excerpt acoustic embeddings and pairwise proximity:

```sh
npm run audio:embed -- --evidence output/evidence.json --output output/embeddings.json
```

The semantic runtime lives in `audio-semantic/` so its native inference dependencies and security overrides remain isolated from the web application. Install it separately with:

```sh
npm install --prefix audio-semantic
```

## Current method and limitations

- DSP decoding is mono at 12 kHz and designed for structural comparison, not mastering decisions.
- Tempo is a pulse candidate, not a guaranteed beat grid.
- Pairwise similarity is relative to the analyzed batch and must not be presented as a universal distance.
- Semantic inference uses a deterministic 10-second excerpt centered on measured peak pressure. It can miss an intro, breakdown, vocal passage, or stylistic change elsewhere in the track.
- Semantic scores are meaningful only inside their declared axis and excerpt. Energy/atmosphere, production texture, rhythmic family, density/space, and emotional color are normalized independently so one broad genre label cannot suppress every other description. Compound labels spanning unrelated properties are avoided because a model may support one half without supporting the other.
- Neither layer creates persistent user taste by default. Saving a recording or a judgment forever remains an explicit future action.

The embedding packet retains opening, quarter, peak-pressure, and ending vectors plus a normalized aggregate so QRator can compare recordings directly while preserving structural change. Human corrections should calibrate the instrument without becoming a hidden permanent taste profile.

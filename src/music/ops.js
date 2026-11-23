// Declarative transformation pipeline.
// The generator only ever produces notes by applying these operations to motif
// events. verifyPipeline() re-applies the recorded ops independently, so the
// note-level link between a derived segment and its source motif can be checked.

import {
  translate,
  invertEvents,
  retrogradeEvents,
  scaleRhythmEvents,
  fragmentEvents,
  compressIntervalsEvents,
  octaveCorrectEvents,
} from './motif.js';
import { SCALES } from './pitch.js';

const EPS = 1e-6;

const mod = (n, m) => ((n % m) + m) % m;

function buildDiatonicLadder(tonicPc, mode) {
  const scale = SCALES[mode];
  if (!scale) throw new Error(`Unknown mode: ${mode}`);
  return scale.map((s) => (tonicPc + s) % 12);
}

/**
 * Diatonic transpose: move by scale degrees, preserving chromatic alteration.
 * Semitone sizes therefore change with position in the scale, which is the
 * point: the operation works on scale-degree relations, not a fixed interval.
 */
export function diatonicTranspose(events, { degrees, tonicPc, mode }) {
  const scale = SCALES[mode];
  const L = scale.length;
  const ladderPitch = (index) => {
    const octave = Math.floor(index / L);
    const degree = mod(index, L);
    return tonicPc + 12 * octave + scale[degree];
  };
  return events.map((e) => {
    const rel = mod(e.pitch - tonicPc, 12);
    let degree = scale.indexOf(rel);
    let octaveOffset = 0;
    let alteration = 0;
    if (degree === -1) {
      // Chromatic note: anchor to the nearest lower scale tone, keep alteration.
      for (let d = 0; d < L; d += 1) {
        const lower = mod(rel - scale[d], 12);
        if (lower <= 2) {
          degree = d;
          alteration = lower;
          // rel = scale[d] + alteration (mod 12); handle wrap at octave edge
          if (mod(scale[d] + alteration, 12) !== rel) alteration -= 12;
          break;
        }
      }
      if (degree === -1) return { ...e, pitch: e.pitch + 12 * Math.trunc(degrees / L) + (degrees % L) };
    }
    const absoluteOctave = Math.floor((e.pitch - tonicPc - alteration) / 12);
    const index = absoluteOctave * L + degree;
    const target = ladderPitch(index + degrees) + alteration;
    return { ...e, pitch: target };
  });
}

/**
 * Diatonic inversion: mirror scale degrees around an axis pitch. Scale tones
 * map to scale tones, so the inversion stays inside the key instead of turning
 * into an arbitrary chromatic sequence. Chromatic alterations are preserved.
 */
export function diatonicInvert(events, { axis, tonicPc, mode }) {
  const scale = SCALES[mode];
  const L = scale.length;
  const degreeOf = (pitch) => {
    const rel = mod(pitch - tonicPc, 12);
    const octave = Math.floor((pitch - tonicPc) / 12);
    let degree = scale.indexOf(rel);
    let alteration = 0;
    if (degree === -1) {
      for (let d = 0; d < L; d += 1) {
        const lower = mod(rel - scale[d], 12);
        if (lower <= 2 && mod(scale[d] + lower, 12) === rel) {
          degree = d;
          alteration = lower;
          break;
        }
      }
      if (degree === -1) degree = 0;
    }
    return { index: octave * L + degree, alteration };
  };
  const pitchOf = (index, alteration) => {
    const octave = Math.floor(index / L);
    const degree = mod(index, L);
    return tonicPc + 12 * octave + scale[degree] + alteration;
  };
  const axisDeg = degreeOf(axis);
  return events.map((e) => {
    const { index, alteration } = degreeOf(e.pitch);
    const mirrored = 2 * axisDeg.index - index;
    return { ...e, pitch: pitchOf(mirrored, alteration) };
  });
}

function localOctave(events, { shifts }) {
  if (!Array.isArray(shifts) || shifts.length !== events.length) {
    throw new Error(`local-octave needs ${events.length} shifts, got ${shifts?.length}`);
  }
  return events.map((e, i) => {
    const s = shifts[i];
    if (s % 12 !== 0) throw new Error('local-octave shifts must be multiples of 12');
    return { ...e, pitch: e.pitch + s };
  });
}

function cadenceTarget(events, { index, pitch }) {
  const i = index < 0 ? events.length + index : index;
  if (i < 0 || i >= events.length) throw new Error(`cadence-target index ${index} out of range`);
  return events.map((e, j) => (j === i ? { ...e, pitch } : e));
}

export const OP_IMPL = {
  fragment: (events, { from, to }) => fragmentEvents(events, from, to),
  rhythm: (events, { factor }) => scaleRhythmEvents(events, factor),
  transpose: (events, { semitones }) => translate(events, semitones),
  'diatonic-transpose': (events, params) => diatonicTranspose(events, params),
  invert: (events, { axis }) => invertEvents(events, axis),
  'diatonic-invert': (events, params) => diatonicInvert(events, params),
  retrograde: (events) => retrogradeEvents(events),
  'octave-shift': (events, { semitones }) => translate(events, semitones),
  'local-octave': (events, params) => localOctave(events, params),
  'compress-intervals': (events, { factor, anchorIndex }) =>
    compressIntervalsEvents(events, factor, anchorIndex),
  'cadence-target': (events, params) => cadenceTarget(events, params),
};

export const OP_LABELS = {
  fragment: (p) => `fragment notes ${p.from + 1}–${p.to + 1}`,
  rhythm: (p) => `rhythm ×${p.factor}`,
  transpose: (p) => `transpose ${p.semitones >= 0 ? '+' : ''}${p.semitones} st`,
  'diatonic-transpose': (p) => `diatonic transpose ${p.degrees >= 0 ? '+' : ''}${p.degrees} deg`,
  invert: (p) => `invert about MIDI ${p.axis}`,
  'diatonic-invert': (p) => `diatonic invert about ${p.axis} (scale degrees)`,
  retrograde: () => 'retrograde (reverse time)',
  'octave-shift': (p) => `octave shift ${p.semitones >= 0 ? '+' : ''}${p.semitones / 12}`,
  'local-octave': () => 'octave-correct individual notes',
  'compress-intervals': (p) => `compress intervals to ${Math.round(p.factor * 100)}% about note ${p.anchorIndex + 1}`,
  'cadence-target': (p) => `cadence-retarget note ${p.index + 1} to MIDI ${p.pitch}`,
};

export function describeOp(op) {
  const fn = OP_LABELS[op.op];
  return fn ? fn(op.params ?? {}) : op.op;
}

/** Attach stable source indices for provenance tracking. */
export function withSourceIndices(events, offset = 0) {
  return events.map((e, i) => ({ ...e, srcIndex: offset + i }));
}

/**
 * Apply a recorded pipeline to motif events.
 * `baseEvents` must be the motif's full event list (indices refer to it).
 */
export function applyPipeline(baseEvents, ops, { startIndex = 0 } = {}) {
  let events = withSourceIndices(baseEvents, 0);
  for (const op of ops) {
    const impl = OP_IMPL[op.op];
    if (!impl) throw new Error(`Unknown operation: ${op.op}`);
    events = impl(events, op.params ?? {});
  }
  return events.map((e) => ({ ...e, start: round(e.start), dur: round(e.dur) }));
}

function round(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Verify that a segment's actual notes are exactly what its recorded lineage
 * produces. This is the core anti-hand-waving check: statistical resemblance is
 * not accepted, the note pitches/times must equal the transformed motif notes.
 */
export function verifyPipeline({ motifEvents, ops, actualEvents, tolerance = 1e-4 }) {
  const errors = [];
  let expected;
  try {
    expected = applyPipeline(motifEvents, ops);
  } catch (err) {
    return { ok: false, errors: [`pipeline failed: ${err.message}`], expected: null };
  }
  if (expected.length !== actualEvents.length) {
    errors.push(`note count mismatch: pipeline yields ${expected.length}, segment has ${actualEvents.length}`);
  }
  const n = Math.min(expected.length, actualEvents.length);
  for (let i = 0; i < n; i += 1) {
    const e = expected[i];
    const a = actualEvents[i];
    if (e.pitch !== a.pitch) {
      errors.push(`note ${i + 1}: expected pitch ${e.pitch}, found ${a.pitch}`);
    }
    if (Math.abs(e.start - a.start) > tolerance) {
      errors.push(`note ${i + 1}: expected start ${e.start}, found ${a.start}`);
    }
    if (Math.abs(e.dur - a.dur) > tolerance) {
      errors.push(`note ${i + 1}: expected dur ${e.dur}, found ${a.dur}`);
    }
    if (e.srcIndex != null && a.sourceIndex != null && e.srcIndex !== a.sourceIndex) {
      errors.push(`note ${i + 1}: expected source index ${e.srcIndex}, found ${a.sourceIndex}`);
    }
  }
  return { ok: errors.length === 0, errors, expected };
}

/** Human-readable lineage chain, e.g. "motif notes 1-4 -> invert -> octave -1". */
export function lineageDescription(segment) {
  const fragment = segment.ops.find((o) => o.op === 'fragment');
  const source = `motif “${segment.source.name}”${fragment ? ` notes ${fragment.params.from + 1}–${fragment.params.to + 1}` : ''}`;
  const rest = segment.ops.filter((o) => o.op !== 'fragment');
  if (!rest.length) return `${source} → literal restatement`;
  return `${source} → ${rest.map(describeOp).join(' → ')}`;
}

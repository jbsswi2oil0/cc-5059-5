// Phrase generator.
//
// Design contract:
//  - Hard constraints are binary and separate from stylistic scoring.
//  - Every note is produced by replaying a recorded operation pipeline on the
//    source motif. No note is ever added to pad length.
//  - Slots sit on fixed bar boundaries, so phrase length and harmonic position
//    are structural, not accidental.
//  - Non-chord tones are allowed only under declared passing/auxiliary rules.

import {
  parsePitch,
  parsePitchClass,
  pitchClass,
  midiToPitch,
  pcName,
  makeHarmony,
  chordAt,
} from './pitch.js';
import {
  normalizeMotif,
  contourSimilarity,
  resolveInversionRange,
} from './motif.js';
import {
  applyPipeline,
  verifyPipeline,
  describeOp,
  lineageDescription,
} from './ops.js';

export const ENGINE_VERSION = '1.0.0';

const EPS = 1e-6;
const roundBeat = (v) => Math.round(v * 1e6) / 1e6;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------
// Deterministic RNG / hashing
// ---------------------------------------------------------------------------

export function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededKey(seedText, ...parts) {
  return hashString([seedText, ...parts].join('|'));
}

function seededOrder(seedText, count) {
  const rng = mulberry32(parseInt(hashString(seedText), 16));
  return Array.from({ length: count }, () => rng());
}

/** Collect diagnostics, collapsing repeated causes so real problems stay visible. */
function createDiagnostics(limit = 24) {
  const seen = new Map();
  return {
    add(message, key = message) {
      const k = key.replace(/@-?\d+/g, '@N');
      if (seen.has(k)) {
        seen.get(k).count += 1;
        return;
      }
      if (seen.size >= limit) {
        const overflow = seen.get('__overflow__');
        if (overflow) overflow.count += 1;
        else seen.set('__overflow__', { count: 1, message: '… further distinct diagnostics suppressed' });
        return;
      }
      seen.set(k, { count: 1, message });
    },
    toArray() {
      return [...seen.values()].map((v) => (v.count > 1 ? `${v.message} [×${v.count}]` : v.message));
    },
    get size() {
      return seen.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Phrase templates ("分句规则")
// ---------------------------------------------------------------------------

export const PHRASE_TEMPLATES = {
  'statement-development-cadence': {
    id: 'statement-development-cadence',
    name: '陈述 → 展开 → 收束 (A A′ B A″)',
    description: 'State the theme, vary it, develop contrast, then cadence on the target.',
    slots: [
      { role: 'A', label: '主题陈述', cadence: false, prefer: 'statement', bars: 2 },
      { role: 'A′', label: '变化重复', cadence: false, prefer: 'transpose', bars: 2 },
      { role: 'B', label: '对比展开', cadence: false, prefer: 'contrast', bars: 2 },
      { role: 'A″', label: '终止收束', cadence: true, prefer: 'cadence', bars: 2 },
    ],
  },
  arch: {
    id: 'arch',
    name: '拱形展开 (A B A′ C)',
    description: 'Rise through transformed fragments, restate near the peak, then close.',
    slots: [
      { role: 'A', label: '起句', cadence: false, prefer: 'statement', bars: 2 },
      { role: 'B', label: '上行展开', cadence: false, prefer: 'rise', bars: 2 },
      { role: "A′", label: '拱顶回顾', cadence: false, prefer: 'transpose', bars: 2 },
      { role: 'C', label: '收束', cadence: true, prefer: 'cadence', bars: 2 },
    ],
  },
  'three-phase': {
    id: 'three-phase',
    name: '三段式 (A A′ A″cad)',
    description: 'One motif, one development, then a cadential derivative.',
    slots: [
      { role: 'A', label: '主题', cadence: false, prefer: 'statement', bars: 2 },
      { role: 'A′', label: '发展', cadence: false, prefer: 'contrast', bars: 2 },
      { role: 'A″', label: '收束', cadence: true, prefer: 'cadence', bars: 2 },
    ],
  },
  sentence: {
    id: 'sentence',
    name: '乐句式 (basic idea + fragmentation)',
    description: 'Present a fragment, sequence it, fragment it further, then cadence.',
    slots: [
      { role: 'a', label: '基本乐思', cadence: false, prefer: 'statement', bars: 2 },
      { role: 'a′', label: '模进', cadence: false, prefer: 'transpose', bars: 2 },
      { role: 'b', label: '分裂', cadence: false, prefer: 'fragment', bars: 2 },
      { role: 'cad', label: '终止式', cadence: true, prefer: 'cadence', bars: 2 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const DEFAULT_OPTIONS = {
  key: { tonic: 'C', mode: 'major' },
  register: { lowNote: 'C4', highNote: 'A5' },
  meter: [4, 4],
  tempo: 96,
  harmony: ['C', 'Am', 'F', 'C'],
  ending: { pc: 'C', lowNote: 'C4', highNote: 'C5', exactMidi: null, label: 'tonic close' },
  template: 'statement-development-cadence',
  candidateCount: 8,
  seed: 'theme-1',
  allow: { inversion: true, retrograde: true, rhythm: true, diatonicTranspose: true },
  rhythmFactors: [1, 1.25, 1.5, 2, 0.75],
  nonChordRules: { passing: true, auxiliary: true, maxDur: 1.5 },
  slotVariantCap: 44,
};

export function resolveOptions(input = {}) {
  const merged = {
    ...DEFAULT_OPTIONS,
    ...input,
    key: { ...DEFAULT_OPTIONS.key, ...(input.key ?? {}) },
    register: { ...DEFAULT_OPTIONS.register, ...(input.register ?? {}) },
    ending: { ...DEFAULT_OPTIONS.ending, ...(input.ending ?? {}) },
    allow: { ...DEFAULT_OPTIONS.allow, ...(input.allow ?? {}) },
    nonChordRules: { ...DEFAULT_OPTIONS.nonChordRules, ...(input.nonChordRules ?? {}) },
  };
  merged.tonicPc = typeof merged.key.tonic === 'string' && /^[A-Ga-g][#b♯♭]?$/.test(merged.key.tonic.trim())
    ? parsePitchClass(merged.key.tonic)
    : merged.key.tonic;
  merged.low = typeof merged.register.lowNote === 'string'
    ? parsePitch(merged.register.lowNote)
    : merged.register.lowNote;
  merged.high = typeof merged.register.highNote === 'string'
    ? parsePitch(merged.register.highNote)
    : merged.register.highNote;
  if (merged.low > merged.high) throw new Error('Register low is above register high');

  merged.endingPc = merged.ending.pc == null ? null : parsePitchClass(merged.ending.pc);
  merged.endingLow = merged.ending.lowNote == null ? merged.low
    : typeof merged.ending.lowNote === 'string' ? parsePitch(merged.ending.lowNote) : merged.ending.lowNote;
  merged.endingHigh = merged.ending.highNote == null ? merged.high
    : typeof merged.ending.highNote === 'string' ? parsePitch(merged.ending.highNote) : merged.ending.highNote;
  merged.endingExact = merged.ending.exactMidi ?? null;
  if (merged.endingExact != null) {
    merged.endingPc = pitchClass(merged.endingExact);
    merged.endingLow = merged.endingExact;
    merged.endingHigh = merged.endingExact;
  }

  const template = PHRASE_TEMPLATES[merged.template];
  if (!template) throw new Error(`Unknown phrase template: ${merged.template}`);
  merged.templateDef = template;
  merged.beatsPerBar = merged.meter[0] * (4 / merged.meter[1]);
  merged.totalBars = template.slots.reduce((s, slot) => s + slot.bars, 0);
  merged.totalBeats = merged.totalBars * merged.beatsPerBar;
  let cursor = 0;
  merged.slotLayout = template.slots.map((slot) => {
    const start = cursor;
    cursor += slot.bars * merged.beatsPerBar;
    return { ...slot, start, budget: slot.bars * merged.beatsPerBar };
  });
  merged.lengthMin = merged.totalBeats * 0.75;
  merged.lengthMax = merged.totalBeats * 1.02;
  return merged;
}

// ---------------------------------------------------------------------------
// Harmony
// ---------------------------------------------------------------------------

function buildHarmony(opts) {
  const bars = [];
  for (let i = 0; i < opts.totalBars + 2; i += 1) {
    const symbol = opts.harmony[i % opts.harmony.length];
    // Repeat the cycle label so UI can show the source chord, not the literal repeat.
    bars.push(symbol);
  }
  return makeHarmony(bars, { meter: opts.meter, tempo: opts.tempo });
}

// ---------------------------------------------------------------------------
// Chord-tone classification and declared non-chord figures
// ---------------------------------------------------------------------------

export function classifyNotes(events, harmony, rules, { beatsPerBar }) {
  const maxDur = rules.maxDur ?? 1;
  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const chord = chordAt(harmony, e.start);
    const pc = pitchClass(e.pitch);
    const isChordTone = chord ? chord.pcs.includes(pc) : false;
    const entry = {
      index: i,
      pitch: e.pitch,
      note: midiToPitch(e.pitch),
      start: e.start,
      dur: e.dur,
      beatInBar: roundBeat(e.start % beatsPerBar),
      chord: chord?.label ?? null,
      chordPcs: chord ? chord.pcs.slice() : [],
      chordTone: isChordTone,
      type: isChordTone ? 'chord' : 'unpermitted',
      rule: null,
      reason: null,
    };
    if (isChordTone) {
      entry.reason = `chord tone of ${chord.label}`;
      out.push(entry);
      continue;
    }
    const prev = events[i - 1] ?? null;
    const next = events[i + 1] ?? null;
    const prevChord = prev ? chordToneOf(prev, harmony) : false;
    const nextChord = next ? chordToneOf(next, harmony) : false;
    const short = e.dur <= maxDur + EPS;
    const weak = Math.abs(entry.beatInBar - Math.round(entry.beatInBar)) > EPS
      || entry.beatInBar % (beatsPerBar / 2) > EPS;

    if (rules.passing && prev && next && prevChord && nextChord && short) {
      const stepIn = Math.abs(prev.pitch - e.pitch);
      const stepOut = Math.abs(next.pitch - e.pitch);
      const monotonic = (prev.pitch < e.pitch && e.pitch < next.pitch)
        || (prev.pitch > e.pitch && e.pitch > next.pitch);
      if (monotonic && stepIn <= 2 && stepOut <= 2) {
        entry.type = 'passing';
        entry.rule = 'passing';
        entry.reason = `passing tone between ${midiToPitch(prev.pitch)} and ${midiToPitch(next.pitch)}`;
        entry.detail = { stepIn, stepOut, weak };
        out.push(entry);
        continue;
      }
    }
    if (rules.auxiliary && prev && next && prevChord && nextChord && short) {
      const stepIn = Math.abs(prev.pitch - e.pitch);
      const stepOut = Math.abs(next.pitch - e.pitch);
      const sameReturn = pitchClass(prev.pitch) === pitchClass(next.pitch)
        && Math.abs(prev.pitch - next.pitch) <= 12;
      if (stepIn <= 2 && stepOut <= 2 && sameReturn) {
        entry.type = 'auxiliary';
        entry.rule = 'auxiliary';
        entry.reason = `auxiliary note against ${midiToPitch(prev.pitch)}`;
        entry.detail = { stepIn, stepOut, weak };
        out.push(entry);
        continue;
      }
    }
    entry.reason = rules.passing || rules.auxiliary
      ? 'non-chord note does not fit any declared passing/auxiliary figure'
      : 'non-chord tones are not permitted by the declared rules';
    out.push(entry);
  }
  return out;
}

function chordToneOf(event, harmony) {
  const chord = chordAt(harmony, event.start);
  return chord ? chord.pcs.includes(pitchClass(event.pitch)) : false;
}

// ---------------------------------------------------------------------------
// Candidate segments
// ---------------------------------------------------------------------------

function fragmentChoices(motifEvents, prefer) {
  const n = motifEvents.length;
  if (n < 2) return [];
  const choices = [];
  const add = (from, to, label) => {
    if (from < 0 || to >= n || to - from + 1 < 2) return;
    choices.push({ from, to, label: label ?? `notes ${from + 1}–${to + 1}` });
  };
  add(0, n - 1, 'full motif');
  if (n >= 4) {
    add(0, n - 2, 'motif head (without final note)');
    add(1, n - 1, 'motif tail');
    add(0, Math.max(1, Math.floor(n * 0.6) - 1), 'motif opening');
    add(Math.max(0, Math.ceil(n * 0.4)), n - 1, 'motif closing');
  }
  if (prefer === 'fragment' && n >= 5) add(1, Math.min(n - 1, 3), 'inner fragment');
  if (prefer === 'cadence' && n >= 3) add(n - 2, n - 1, 'cadential tail');
  if (prefer === 'cadence') add(0, n - 1, 'full motif');
  const seen = new Set();
  return choices.filter((c) => {
    const k = `${c.from}:${c.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function axisCandidates(tonicPc, motifEvents) {
  const first = motifEvents[0].pitch;
  const last = motifEvents[motifEvents.length - 1].pitch;
  const tonicNear = tonicPc + 12 * Math.round((first - tonicPc) / 12);
  const axes = new Set([first, last, Math.round((first + last) / 2), tonicNear, tonicNear + 7]);
  for (let d = -3; d <= 3; d += 1) axes.add(first + d);
  return [...axes].sort((a, b) => a - b);
}

function durationOf(events) {
  return events.length ? Math.max(...events.map((e) => e.start + e.dur)) : 0;
}

function fitRhythmFactors(baseDuration, budget, allowRhythm, userFactors, { mustReachEnd = false } = {}) {
  const usableMax = budget * 0.92;
  const usableMin = budget * 0.5;
  // A cadential segment must sustain into the final bar, so its material has to
  // occupy close to the whole slot. Push the lower bound up accordingly.
  const minDur = mustReachEnd ? budget * 0.84 : usableMin;
  const fitOk = (dur) => dur <= usableMax + EPS && dur >= minDur - EPS;
  if (fitOk(baseDuration)) return [1];
  if (!allowRhythm) return baseDuration <= usableMax + EPS && baseDuration >= minDur - EPS ? [1] : [];
  const factors = new Set();
  for (const target of [usableMax, budget * 0.9, budget * 0.86, usableMin]) {
    let f = target / baseDuration;
    f = Math.max(0.15, Math.min(3, Math.round(f * 20) / 20));
    if (fitOk(baseDuration * f)) factors.add(f);
  }
  for (const f of userFactors) {
    if (fitOk(baseDuration * f)) factors.add(f);
  }
  return [...factors].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1) || a - b);
}

function qualityOfVariant(variant, slot, opts, slotStart) {
  let q = 0.5;
  const prefer = slot.prefer;
  if (variant.transformKind === 'literal') q += prefer === 'statement' ? 0.3 : -0.05;
  if (prefer === 'transpose' && variant.transformKind.startsWith('transpose')) q += 0.25;
  if (prefer === 'contrast' && (variant.inversionFamily || variant.transformKind === 'retrograde')) q += 0.3;
  if (prefer === 'contrast' && variant.ops.some((o) => o.op === 'rhythm')) q += 0.12;
  if (prefer === 'fragment' && variant.ops.some((o) => o.op === 'fragment')) q += 0.25;
  if (prefer === 'cadence' && variant.fallbackCadence) q -= 0.15;
  if (prefer === 'cadence' && variant.ops.some((o) => o.op === 'fragment')) q += 0.05;
  if (prefer === 'rise') {
    const meanLocal = variant.events.reduce((s, e) => s + e.pitch, 0) / variant.events.length;
    const meanSource = opts.motifEvents.reduce((s, e) => s + e.pitch, 0) / opts.motifEvents.length;
    q += clamp01((meanLocal - meanSource + 6) / 12) * 0.25;
  }
  q += clamp01(variant.contour.score) * 0.12;
  if (variant.inversionFamily && variant.ops.some((o) => ['octave-shift', 'compress-intervals', 'local-octave'].includes(o.op))) {
    q += 0.03;
  }
  if (variant.harmonyBad > 0) q -= 0.5;
  // Position-aware: reward landing a chord tone near the slot's middle/end.
  const last = variant.events[variant.events.length - 1];
  if (last && chordToneOf({ ...last, start: slotStart + last.start }, opts.harmonyObj)) q += 0.05;
  return q;
}

/**
 * Build every derivable, register-legal, harmony-legal segment for one slot.
 * Inversions that leave the register are repaired by comparing whole-segment
 * octave transposition against interval compression / local octave correction,
 * arbitrated by contour preservation.
 */
export function buildSlotVariants({ slot, opts, motifEvents, diagnostics, slotStart }) {
  const diag = diagnostics;
  const { allow, low, high, tonicPc, endingPc, endingLow, endingHigh, endingExact } = opts;
  const fragments = fragmentChoices(motifEvents, slot.prefer);
  const axes = axisCandidates(tonicPc, motifEvents);
  const rhythmSet = allow.rhythm
    ? [1, ...opts.rhythmFactors].filter((f, i, a) => a.indexOf(f) === i && f > 0)
    : [1];

  const degreeChoices = [0];
  if (allow.diatonicTranspose) {
    for (let d = -7; d <= 7; d += 1) if (d !== 0) degreeChoices.push(d);
  }
  const bases = [];
  const addBase = (ops, kind, inversionFamily = false, preference = 1) => {
    bases.push({ ops, kind, inversionFamily, preference });
  };
  addBase([], 'literal', false, 1.0);
  if (allow.diatonicTranspose) {
    for (const degrees of degreeChoices) {
      if (degrees === 0) continue;
      addBase([{ op: 'diatonic-transpose', params: { degrees, tonicPc, mode: opts.key.mode } }],
        `transpose ${degrees > 0 ? '+' : ''}${degrees}deg`, false, 0.95);
    }
  }
  if (allow.inversion) {
    for (const axis of axes) {
      addBase([{ op: 'diatonic-invert', params: { axis, tonicPc, mode: opts.key.mode } }],
        `invert@${axis}`, true, 1.0);
      if (allow.retrograde) {
        addBase([
          { op: 'diatonic-invert', params: { axis, tonicPc, mode: opts.key.mode } },
          { op: 'retrograde' },
        ], `invert@${axis}+retro`, true, 0.9);
      }
    }
  }
  if (allow.retrograde) {
    addBase([{ op: 'retrograde' }], 'retrograde', false, 0.9);
    if (allow.diatonicTranspose) {
      for (const degrees of [-3, -2, 2, 3]) {
        addBase([
          { op: 'diatonic-transpose', params: { degrees, tonicPc, mode: opts.key.mode } },
          { op: 'retrograde' },
        ], `transpose ${degrees > 0 ? '+' : ''}${degrees}deg+retro`, false, 0.85);
      }
    }
  }

  const variants = [];
  const cadenceMissPool = [];
  const fragmentLimit = fragments.slice(0, slot.prefer === 'cadence' ? 4 : 5);
  let inversionRepairs = 0;
  let naturalCadenceFound = false;
  let cadenceConflict = null;
  let inversionRejected = 0;
  let cadenceDroppedHarmony = 0;
  const repairLog = [];

  const tryVariant = (fragment, fragOps, base, factor) => {
    let ops = [...fragOps, ...base.ops];
    let events;
    try {
      events = applyPipeline(motifEvents, ops);
    } catch (err) {
      diag.add(`${slot.role}: pipeline rejected (${err.message})`, `${slot.role}: pipeline-rejected`);
      return;
    }
    if (events.length < 2) return;

    const beforeRhythm = events;
    if (factor !== 1) {
      ops = [...ops, { op: 'rhythm', params: { factor } }];
      events = applyPipeline(motifEvents, ops);
    }
    const dur = durationOf(events);
    if (dur > slot.budget * 0.92 + EPS) return;
    if (dur < slot.budget * 0.5 - EPS) return;
    // The cadential segment must sustain into the final bar of its slot; a short
    // segment cannot close the phrase no matter which note it ends on.
    if (slot.cadence && dur < slot.budget * 0.84 - EPS) return;

    const outOfRange = events.some((e) => e.pitch < low || e.pitch > high);
    const endingLocked = slot.cadence;
    const endingState = endingLocked
      ? { pc: endingPc, exactMidi: endingExact, low: endingLow, high: endingHigh }
      : null;
    const lastPitch = events[events.length - 1].pitch;
    const endingAlreadyOk = !endingLocked || naturalEndingMatch(lastPitch, endingState);
    let repairInfo = null;
    if (outOfRange) {
      if (!base.inversionFamily) return;
      // Register repair is independent of the cadence target. Passing `ending`
      // here would demand the final note already be the cadence note, and an
      // inversion is unlikely to land there naturally; the cadence-target op
      // handles that afterwards as its own, separately recorded step.
      const resolution = resolveInversionRange({
        rawEvents: events.map(({ srcIndex, ...rest }) => rest),
        sourceEvents: null,
        low,
        high,
        ending: null,
      });
      if (!resolution.feasible) {
        inversionRejected += 1;
        const bestInvalid = resolution.candidates[0];
        diag.add(
          `${slot.role}: inversion ${base.kind} cannot fit register ${midiToPitch(low)}–${midiToPitch(high)}; best repair (${bestInvalid?.type}) still violates the bounds`,
          `${slot.role}: inversion-register-fail`,
        );
        return;
      }
      const repairOps = repairOpsFromResolution(resolution.chosen, events);
      ops = [...ops, ...repairOps];
      try {
        events = applyPipeline(motifEvents, ops);
      } catch (err) {
        diag.add(`${slot.role}: repair pipeline rejected (${err.message})`, `${slot.role}: repair-pipeline`);
        return;
      }
      inversionRepairs += 1;
      repairInfo = {
        slot: slot.role,
        transform: base.kind,
        chosen: resolution.chosen.type,
        chosenDetail: resolution.chosen.reason,
        contour: Number(resolution.chosen.contour.score.toFixed(3)),
        // One representative per repair type so the octave-vs-compression
        // comparison is visible rather than four octave shifts.
        alternatives: bestPerType(resolution.candidates).map((c) => ({
          type: c.type,
          detail: c.reason,
          contour: Number(c.contour.score.toFixed(3)),
          valid: c.valid,
        })),
        preview: events.map((e) => midiToPitch(e.pitch)),
      };
      if (repairLog.length < 6) repairLog.push(repairInfo);
    } else if (endingLocked && !endingAlreadyOk && base.inversionFamily && endingExact == null) {
      // An inversion may still be repairable into both register and the ending
      // register; try the full arbitration including the ending constraint.
      const resolution = resolveInversionRange({
        rawEvents: events.map(({ srcIndex, ...rest }) => rest),
        sourceEvents: null,
        low,
        high,
        ending: endingState,
      });
      if (resolution.feasible) {
        ops = [...ops, ...repairOpsFromResolution(resolution.chosen, events)];
        try {
          events = applyPipeline(motifEvents, ops);
          inversionRepairs += 1;
          repairInfo = {
            slot: slot.role,
            transform: base.kind,
            chosen: resolution.chosen.type,
            chosenDetail: resolution.chosen.reason,
            contour: Number(resolution.chosen.contour.score.toFixed(3)),
            alternatives: bestPerType(resolution.candidates).map((c) => ({
              type: c.type,
              detail: c.reason,
              contour: Number(c.contour.score.toFixed(3)),
              valid: c.valid,
            })),
            preview: events.map((e) => midiToPitch(e.pitch)),
          };
          if (repairLog.length < 6) repairLog.push(repairInfo);
        } catch {
          return;
        }
      }
      // Otherwise fall through: the cadence-target step may still fix the ending.
    }
    if (events.some((e) => e.pitch < low || e.pitch > high)) return;
    const finalDur = durationOf(events);
    if (finalDur > slot.budget * 0.92 + EPS) return;

    // Harmony legality at this slot's real position.
    const absEvents = events.map((e) => ({ ...e, start: roundBeat(slotStart + e.start) }));
    const cls = classifyNotes(absEvents, opts.harmonyObj, opts.nonChordRules, { beatsPerBar: opts.beatsPerBar });
    const lastEvent = events[events.length - 1];
    const naturalCadenceOk = !slot.cadence
      || (naturalEndingMatch(lastEvent.pitch, endingState)
        && chordToneOf({ ...lastEvent, start: roundBeat(slotStart + lastEvent.start) }, opts.harmonyObj));
    if (slot.cadence && naturalCadenceOk) naturalCadenceFound = true;

    const sourceEvents = fragment.from === 0 && fragment.to === motifEvents.length - 1
      ? motifEvents
      : motifEvents.slice(fragment.from, fragment.to + 1);
    const contour = contourSimilarity(
      sourceEvents,
      events.map((e) => ({ pitch: e.pitch, start: e.start, dur: e.dur })),
    );

    const variant = {
      ops,
      events,
      sourceLabel: fragment.label,
      fragment,
      transformKind: base.kind + (factor !== 1 ? ` · rhythm×${factor}` : ''),
      inversionFamily: base.inversionFamily,
      rhythmFactor: factor,
      contour,
      cadenceOk: naturalCadenceOk,
      fallbackCadence: false,
      repairInfo,
      preview: cls,
    };
    if (base.cadenceRepair) variant.cadenceRetargeted = true;

    if (slot.cadence && !naturalCadenceOk) {
      // Final note is not yet on the target; keep for the retarget step, but
      // require every other note to be harmony-legal now.
      const nonFinalBad = cls.slice(0, -1).some((n) => n.type === 'unpermitted');
      if (!nonFinalBad) cadenceMissPool.push(variant);
      return;
    }
    if (cls.some((n) => n.type === 'unpermitted')) {
      if (slot.cadence && naturalCadenceOk) cadenceDroppedHarmony += 1;
      return;
    }
    variants.push(variant);
  };

  for (const fragment of fragmentLimit) {
    const fragOps = fragment.from === 0 && fragment.to === motifEvents.length - 1
      ? []
      : [{ op: 'fragment', params: { from: fragment.from, to: fragment.to } }];
    for (const base of bases) {
      let baseEvents;
      try {
        baseEvents = applyPipeline(motifEvents, [...fragOps, ...base.ops]);
      } catch {
        continue;
      }
      const baseDur = durationOf(baseEvents);
      const factors = fitRhythmFactors(baseDur, slot.budget, allow.rhythm, rhythmSet, {
        mustReachEnd: !!slot.cadence,
      });
      for (const factor of factors) tryVariant(fragment, fragOps, base, factor);
    }
  }

  // Cadence fallback: variants that miss the locked ending are retargeted with an
  // explicit recorded operation on a note that already comes from the motif.
  // Variants that still miss the ending after retargeting are discarded, so a
  // phrase can never silently end on the wrong note.
  let cadencePool = variants;
  if (slot.cadence && endingPc != null) {
    const matching = variants;
    const retargeted = [];
    let retargetHarmonyBad = 0;
    let retargetRegisterBad = 0;
    const sourcePool = cadenceMissPool
      .sort((a, b) => b.contour.score - a.contour.score)
      .slice(0, 96);
    for (const variant of sourcePool) {
      const last = variant.events[variant.events.length - 1];
      // Exact mode locks one MIDI note; pitch-class mode picks the nearest member
      // of the target class inside the ending register.
      const target = endingExact != null
        ? (endingExact >= low && endingExact <= high ? endingExact : null)
        : nearestPitchClass(last.pitch, endingPc, { low: endingLow, high: endingHigh });
      if (target == null) {
        retargetRegisterBad += 1;
        continue;
      }
      const ops = [...variant.ops, { op: 'cadence-target', params: { index: variant.events.length - 1, pitch: target } }];
      let events;
      try {
        events = applyPipeline(motifEvents, ops);
      } catch {
        continue;
      }
      if (events.some((e) => e.pitch < low || e.pitch > high)) {
        retargetRegisterBad += 1;
        continue;
      }
      const absEvents = events.map((e) => ({ ...e, start: roundBeat(slotStart + e.start) }));
      const cls = classifyNotes(absEvents, opts.harmonyObj, opts.nonChordRules, { beatsPerBar: opts.beatsPerBar });
      if (cls.some((n) => n.type === 'unpermitted')) {
        retargetHarmonyBad += 1;
        continue;
      }
      retargeted.push({
        ...variant,
        ops,
        events,
        transformKind: `${variant.transformKind}+cadence-target`,
        fallbackCadence: true,
        cadenceOk: true,
        cadenceTargetPitch: target,
        preview: cls,
      });
    }
    if (!matching.length && !retargeted.length) {
      const chord = chordAt(opts.harmonyObj, slotStart);
      if (retargetHarmonyBad) {
        diag.add(
          `${slot.role}: cadence target ${pcName(endingPc)} cannot be reached by retargeting because it is not a legal tone over the final chord ${chord?.label} (${(chord?.pcs ?? []).map((p) => pcName(p)).join(' ')}); ${retargetHarmonyBad} retarget(s) rejected by the harmony rules`,
          `${slot.role}: cadence-harmony-conflict`,
        );
      }
      if (retargetRegisterBad) {
        diag.add(
          `${slot.role}: cadence target ${pcName(endingPc)} has no member within the ending register ${midiToPitch(endingLow)}–${midiToPitch(endingHigh)}; ${retargetRegisterBad} retarget(s) rejected`,
          `${slot.role}: cadence-register-conflict`,
        );
      }
      if (!retargetHarmonyBad && !retargetRegisterBad) {
        if (cadenceDroppedHarmony > 0) {
          diag.add(
            `${slot.role}: ${cadenceDroppedHarmony} cadential segment(s) reached ${pcName(endingPc)} but broke the declared non-chord rules elsewhere in the segment, and none survived retargeting`,
            `${slot.role}: cadence-harmony`,
          );
        } else {
          diag.add(`${slot.role}: no cadential segment could land on ${pcName(endingPc)} within the slot budget`, `${slot.role}: cadence-budget`);
        }
      }
    }
    cadencePool = [...matching, ...retargeted];
    // If nothing can legally reach the ending, report the actual cause rather
    // than an empty-slot message. The chord that matters is the one under the
    // final bar the cadence must close on, not the first bar of the slot.
    if (!cadencePool.length && cadenceMissPool.length) {
      const finalBarStart = slotStart + slot.budget - opts.beatsPerBar;
      const chord = chordAt(opts.harmonyObj, finalBarStart);
      const pcNames = (chord?.pcs ?? []).map((p) => pcName(p)).join(' ');
      const isChordTone = (chord?.pcs ?? []).includes(endingPc);
      if (!isChordTone) {
        cadenceConflict = {
          slot: slot.role,
          targetPc: pcName(endingPc),
          finalChord: chord?.label ?? null,
          chordTones: pcNames,
          detail: `The phrase must end on ${pcName(endingPc)}, but the closing bar is ${chord?.label} (${pcNames}); ${pcName(endingPc)} is a non-chord tone there and no passing/auxiliary figure can apply to a phrase-final note.`,
        };
        diag.add(`${slot.role}: ${cadenceConflict.detail}`, `${slot.role}: cadence-conflict-final`);
      } else {
        diag.add(
          `${slot.role}: candidates reached the target ${pcName(endingPc)} over ${chord?.label}, but every one of them broke the declared non-chord rules elsewhere in the segment`,
          `${slot.role}: cadence-unreachable`,
        );
      }
    }
  }

  // Deduplicate, score, cap.
  const seen = new Set();
  const deduped = [];
  for (const v of cadencePool) {
    const key = JSON.stringify({ o: v.ops, p: v.events.map((e) => [e.pitch, e.start, e.dur]) });
    if (seen.has(key)) continue;
    seen.add(key);
    v.baseQuality = qualityOfVariant(v, slot, opts, slotStart);
    deduped.push(v);
  }
  const orders = seededOrder(seededKey(opts.seed, 'variants', slot.role), deduped.length);
  deduped.forEach((v, i) => { v.order = orders[i]; });
  deduped.sort((a, b) => (b.baseQuality - a.baseQuality) || (a.order - b.order));
  // Keep a deterministic mix: top by quality plus a spread for diversity.
  const top = deduped.slice(0, opts.slotVariantCap);
  const filtered = [];
  const signatures = new Set();
  for (const v of top) {
    const sig = `${v.transformKind}|${v.fragment.from}-${v.fragment.to}|${v.rhythmFactor}`;
    if (signatures.has(sig) && filtered.length > opts.slotVariantCap * 0.6) continue;
    signatures.add(sig);
    filtered.push(v);
  }

  return {
    variants: filtered,
    diagnostics: {
      slot: slot.role,
      total: deduped.length,
      used: filtered.length,
      inversionRepairs,
      inversionRejected,
      naturalCadenceFound,
      cadenceConflict,
      fallbackCadence: filtered.some((v) => v.fallbackCadence),
      repairLog,
    },
  };
}

function naturalEndingMatch(pitch, state) {
  if (!state) return true;
  if (state.exactMidi != null) return pitch === state.exactMidi;
  if (state.pc == null) return true;
  if (pitchClass(pitch) !== state.pc) return false;
  return pitch >= state.low && pitch <= state.high;
}

function nearestPitchClass(midi, pc, { low, high }) {
  let best = null;
  for (let p = low; p <= high; p += 1) {
    if (pitchClass(p) !== pc) continue;
    const d = Math.abs(p - midi);
    if (!best || d < best.d) best = { p, d };
  }
  return best ? best.p : null;
}

function bestPerType(candidates) {
  const order = ['octave-transpose', 'interval-compression', 'local-octave', 'compress+local-octave'];
  const best = new Map();
  for (const c of candidates) {
    const cur = best.get(c.type);
    if (!cur || (c.valid && !cur.valid) || (c.valid === cur.valid && c.contour.score > cur.contour.score)) {
      best.set(c.type, c);
    }
  }
  return order.filter((t) => best.has(t)).map((t) => best.get(t));
}

function repairOpsFromResolution(chosen, preRepair) {
  if (chosen.type === 'octave-transpose') {
    return [{ op: 'octave-shift', params: { semitones: chosen.params.semitones } }];
  }
  if (chosen.type === 'interval-compression') {
    return [{ op: 'compress-intervals', params: { factor: chosen.params.factor, anchorIndex: preRepair.length - 1 } }];
  }
  if (chosen.type === 'local-octave') {
    const shifts = preRepair.map((e, i) => chosen.events[i].pitch - e.pitch);
    return [{ op: 'local-octave', params: { shifts } }];
  }
  if (chosen.type === 'compress+local-octave') {
    const compressed = applyPipeline(preRepair.map(({ srcIndex, ...rest }) => rest), [
      { op: 'compress-intervals', params: { factor: chosen.params.factor, anchorIndex: 0 } },
    ]);
    const shifts = compressed.map((e, i) => chosen.events[i].pitch - e.pitch);
    return [
      { op: 'compress-intervals', params: { factor: chosen.params.factor, anchorIndex: 0 } },
      { op: 'local-octave', params: { shifts } },
    ];
  }
  throw new Error(`Unknown resolution type: ${chosen.type}`);
}

// ---------------------------------------------------------------------------
// Assembly and hard constraints
// ---------------------------------------------------------------------------

function placeSlot(variant, layoutSlot) {
  return variant.events.map((e) => ({
    ...e,
    localStart: e.start,
    start: roundBeat(layoutSlot.start + e.start),
  }));
}

function assemblePhrase(choices, opts) {
  const segments = choices.map((v, i) => {
    const layout = opts.slotLayout[i];
    const events = placeSlot(v, layout);
    return {
      role: layout.role,
      label: layout.label,
      slotStart: layout.start,
      slotBudget: layout.budget,
      ops: v.ops,
      events,
      sourceLabel: v.sourceLabel,
      fragment: v.fragment,
      transformKind: v.transformKind,
      inversionFamily: v.inversionFamily,
      rhythmFactor: v.rhythmFactor,
      fallbackCadence: !!v.fallbackCadence,
      cadenceTargetPitch: v.cadenceTargetPitch ?? null,
      contour: v.contour,
      repairInfo: v.repairInfo ?? null,
    };
  });
  return { segments, events: segments.flatMap((s) => s.events), totalBeats: opts.totalBeats };
}

function cadenceCheck(segments, opts, harmony) {
  const lastSeg = segments[segments.length - 1];
  const lastNote = lastSeg?.events[lastSeg.events.length - 1];
  if (!lastNote) return { ok: false, message: 'phrase has no final note' };
  // The cadence must actually close the phrase: the final attack belongs in the
  // last bar of the final slot, not merely somewhere inside it.
  const finalBarStart = opts.totalBeats - opts.beatsPerBar;
  if (lastNote.start < finalBarStart - EPS) {
    return {
      ok: false,
      message: `phrase does not close in the final bar: last attack at beat ${roundBeat(lastNote.start)}, final bar starts at ${roundBeat(finalBarStart)}`,
      code: 'cadence-early',
    };
  }
  if (opts.endingExact != null && lastNote.pitch !== opts.endingExact) {
    return {
      ok: false,
      message: `final note ${midiToPitch(lastNote.pitch)} ≠ locked target ${midiToPitch(opts.endingExact)}`,
      code: 'ending-locked',
    };
  }
  if (opts.endingPc != null && pitchClass(lastNote.pitch) !== opts.endingPc) {
    return {
      ok: false,
      message: `final note ${midiToPitch(lastNote.pitch)} is not the requested ending ${pcName(opts.endingPc)}`,
      code: 'ending-pc',
    };
  }
  if (lastNote.pitch < opts.endingLow || lastNote.pitch > opts.endingHigh) {
    return {
      ok: false,
      message: `final note ${midiToPitch(lastNote.pitch)} is outside ending register ${midiToPitch(opts.endingLow)}–${midiToPitch(opts.endingHigh)}`,
      code: 'ending-register',
    };
  }
  const chord = chordAt(harmony, lastNote.start);
  if (!chord || !chord.pcs.includes(pitchClass(lastNote.pitch))) {
    return {
      ok: false,
      message: `ending target ${midiToPitch(lastNote.pitch)} is not a chord tone of final chord ${chord?.label ?? '—'} (${(chord?.pcs ?? []).map((p) => pcName(p)).join(' ')})`,
      code: 'cadence-conflict',
    };
  }
  return { ok: true, chord: chord.label };
}

function evaluateConstraints(phrase, opts, harmony, harmonyBadNotes = []) {
  const violations = [];
  const checks = [];
  const pushCheck = (id, label, ok, detail) => {
    checks.push({ id, label, ok, detail });
    if (!ok) violations.push({ code: id, message: detail });
  };

  const out = phrase.events.filter((e) => e.pitch < opts.low || e.pitch > opts.high);
  pushCheck('register', '旋律音域', out.length === 0,
    out.length === 0
      ? `all ${phrase.events.length} notes within ${midiToPitch(opts.low)}–${midiToPitch(opts.high)}`
      : `${out.length} note(s) outside ${midiToPitch(opts.low)}–${midiToPitch(opts.high)}: ${out.map((e) => midiToPitch(e.pitch)).join(', ')}`);

  const classified = classifyNotes(phrase.events, harmony, opts.nonChordRules, { beatsPerBar: opts.beatsPerBar });
  const badNotes = classified.filter((n) => n.type === 'unpermitted');
  pushCheck('harmony', '和声支撑 / 和弦外音规则', badNotes.length === 0,
    badNotes.length === 0
      ? `${classified.filter((n) => n.type === 'chord').length}/${classified.length} chord tones; ${classified.filter((n) => n.type === 'passing' || n.type === 'auxiliary').length} declared passing/auxiliary notes`
      : `${badNotes.length} unpermitted non-chord note(s): ${badNotes.slice(0, 6).map((n) => `${n.note}@${roundBeat(n.start)} (${n.reason})`).join('; ')}`);

  const cad = cadenceCheck(phrase.segments, opts, harmony);
  pushCheck('ending', '结尾目标', cad.ok,
    cad.ok ? `ends on ${midiToPitch(phrase.segments.at(-1).events.at(-1).pitch)} over ${cad.chord}` : cad.message);

  const engaged = phrase.segments.reduce((s, seg) => s + (seg.events.at(-1).start + seg.events.at(-1).dur - seg.slotStart), 0);
  const lengthOk = phrase.totalBeats >= opts.lengthMin - EPS && phrase.totalBeats <= opts.lengthMax + EPS
    && phrase.segments.every((seg) => seg.events.at(-1).start + seg.events.at(-1).dur - seg.slotStart >= seg.slotBudget * 0.5 - EPS);
  pushCheck('length', '乐句长度与分句填充', lengthOk,
    `${roundBeat(phrase.totalBeats)} beats across ${phrase.segments.length} slots (occupied ${roundBeat(engaged)} beats); each slot ≥ 50% filled`);

  let lineageOk = true;
  const lineageErrors = [];
  for (const seg of phrase.segments) {
    if (!seg.ops) {
      lineageOk = false;
      lineageErrors.push(`${seg.role}: no operation record`);
      continue;
    }
    const v = verifyPipeline({
      motifEvents: opts.motifEvents,
      ops: seg.ops,
      actualEvents: seg.events.map((e) => ({ ...e, start: e.localStart })),
    });
    if (!v.ok) {
      lineageOk = false;
      lineageErrors.push(`${seg.role}: ${v.errors.join('; ')}`);
    }
  }
  pushCheck('lineage', '动机谱系可复现', lineageOk,
    lineageOk ? `all ${phrase.segments.length} segments replay exactly from recorded motif operations` : lineageErrors.join(' | '));

  pushCheck('segments', '分句结构',
    phrase.segments.every((s) => s.events.length >= 2) && phrase.segments.length === opts.templateDef.slots.length,
    `${phrase.segments.length}/${opts.templateDef.slots.length} segments; note counts ${phrase.segments.map((s) => s.events.length).join('/')}`);

  if (harmonyBadNotes.length) {
    violations.push(...harmonyBadNotes.map((m) => ({ code: 'harmony', message: m })));
  }

  return { ok: violations.length === 0, violations, checks, classified };
}

function styleScore(phrase, opts, harmony, classified) {
  const comps = [];
  const add = (key, label, value, weight, detail) => {
    const v = clamp01(value);
    comps.push({ key, label, value: v, weight, contribution: v * weight, detail });
  };

  const factors = phrase.segments.map((s) => s.rhythmFactor ?? 1);
  const patterns = new Set(phrase.segments.map((s) => s.events.map((e) => roundBeat(e.dur)).join(',')));
  const factorSpread = Math.max(...factors) - Math.min(...factors);
  add('rhythm', '节奏变化', 0.55 * (patterns.size / phrase.segments.length) + 0.45 * clamp01(factorSpread / 1.5), 0.16,
    `${patterns.size} distinct rhythmic shapes; expansion factors ${[...new Set(factors)].join(', ')}`);

  const means = phrase.segments.map((s) => s.events.reduce((a, e) => a + e.pitch, 0) / s.events.length);
  const meanSpread = Math.max(...means) - Math.min(...means);
  const span = Math.max(...phrase.events.map((e) => e.pitch)) - Math.min(...phrase.events.map((e) => e.pitch));
  add('register', '音区对比', clamp01(meanSpread / 12) * 0.6 + clamp01(span / 18) * 0.4, 0.13,
    `segment mean spread ${Math.round(meanSpread)} st; overall span ${span} st`);

  const chordToneRatio = classified.filter((n) => n.type === 'chord').length / classified.length;
  add('harmony', '和声贴合', chordToneRatio, 0.16, `${Math.round(chordToneRatio * 100)}% chord tones`);

  const lastSeg = phrase.segments.at(-1);
  const lastNote = lastSeg.events.at(-1);
  const prev = lastSeg.events.at(-2);
  const beatInBar = lastNote.start % opts.beatsPerBar;
  const strongBeat = Math.abs(beatInBar) < EPS || Math.abs(beatInBar - opts.beatsPerBar / 2) < EPS;
  const stepApproach = prev ? Math.abs(lastNote.pitch - prev.pitch) <= 2 : false;
  const cadValue = (strongBeat ? 0.4 : 0.15) + (stepApproach ? 0.35 : 0.15) + (lastSeg.fallbackCadence ? 0.1 : 0.25);
  add('cadence', '终止力度', cadValue, 0.2,
    `final attack at beat ${roundBeat(beatInBar)}${strongBeat ? ' (strong)' : ''}; ${stepApproach ? 'stepwise' : 'leap'} approach${lastSeg.fallbackCadence ? '; final note retargeted' : ''}`);

  const opTypes = new Set(phrase.segments.flatMap((s) => s.ops.map((o) => o.op)));
  const nonLiteral = phrase.segments.slice(1).filter((s) => s.ops.some((o) => o.op !== 'fragment')).length;
  add('development', '动机发展', 0.45 * clamp01(nonLiteral / Math.max(1, phrase.segments.length - 1))
    + 0.3 * clamp01((opTypes.size - 1) / 4) + 0.25 * (opTypes.has('diatonic-invert') ? 1 : 0.4), 0.15,
    `${nonLiteral} transformed segments; operations ${[...opTypes].map(opName).join(', ')}`);

  const peak = phrase.events.reduce((best, e) => (e.pitch > best.pitch ? e : best), phrase.events[0]);
  const peakPos = peak.start / phrase.totalBeats;
  add('arc', '句法走向', 1 - Math.min(1, Math.abs(peakPos - 0.66) / 0.5), 0.08,
    `climax at ${Math.round(peakPos * 100)}% of the phrase`);

  const occupied = phrase.segments.reduce((s, seg) => s + (seg.events.at(-1).start + seg.events.at(-1).dur - seg.slotStart), 0);
  add('lengthFit', '长度贴合', occupied / phrase.totalBeats, 0.12,
    `${roundBeat(occupied)}/${roundBeat(phrase.totalBeats)} beats actively filled`);

  const total = comps.reduce((s, c) => s + c.contribution, 0);
  return { total: Math.round(total * 1000) / 1000, components: comps };
}

function opName(op) {
  return {
    fragment: 'fragment',
    rhythm: 'rhythm',
    'diatonic-transpose': 'transpose',
    'diatonic-invert': 'inversion',
    'octave-shift': 'octave shift',
    'compress-intervals': 'interval compression',
    'local-octave': 'octave correction',
    retrograde: 'retrograde',
    'cadence-target': 'cadence retarget',
  }[op] ?? op;
}

function segmentProfile(seg, opts) {
  const sourceNotes = seg.fragment
    ? opts.motifEvents.slice(seg.fragment.from, seg.fragment.to + 1)
    : opts.motifEvents;
  const localEvents = seg.events.map((e) => ({ pitch: e.pitch, start: e.localStart, dur: e.dur }));
  const contour = contourSimilarity(sourceNotes, localEvents);
  return {
    ...seg,
    source: { id: opts.motif.id, name: opts.motif.name, noteCount: opts.motifEvents.length },
    sourceNoteRange: seg.fragment
      ? { from: seg.fragment.from, to: seg.fragment.to }
      : { from: 0, to: opts.motifEvents.length - 1 },
    sourcePitches: sourceNotes.map((e) => e.pitch),
    lineage: lineageDescription({ source: { name: opts.motif.name }, ops: seg.ops }),
    opSummary: seg.ops.map((o) => ({ op: o.op, params: o.params, label: describeOp(o) })),
    contour,
    verification: verifyPipeline({
      motifEvents: opts.motifEvents,
      ops: seg.ops,
      actualEvents: localEvents,
    }),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generatePhrases(motifInput, options = {}) {
  const opts = resolveOptions(options);
  const motif = normalizeMotif({ ...motifInput, id: motifInput.id ?? 'motif', name: motifInput.name ?? 'Motif' });
  const motifEvents = motif.events.map((e) => ({ ...e }));
  if (motifEvents.length < 2) throw new Error('Motif needs at least 2 notes');
  opts.motif = motif;
  opts.motifEvents = motifEvents;
  opts.harmonyObj = buildHarmony(opts);

  const inputErrors = [];
  const outOfRegisterMotif = motifEvents.filter((e) => e.pitch < opts.low || e.pitch > opts.high);
  if (outOfRegisterMotif.length) {
    inputErrors.push({
      code: 'motif-register',
      message: `Motif notes lie outside the selected register ${midiToPitch(opts.low)}–${midiToPitch(opts.high)}: ${outOfRegisterMotif.map((e) => midiToPitch(e.pitch)).join(', ')}`,
    });
  }
  const motifHarmonyClass = classifyNotes(motifEvents, opts.harmonyObj, opts.nonChordRules, { beatsPerBar: opts.beatsPerBar });
  const motifHarmonyBad = motifHarmonyClass.filter((n) => n.type === 'unpermitted');
  const motifHarmonyWarning = motifHarmonyBad.length
    ? `Motif contains ${motifHarmonyBad.length} note(s) outside the declared non-chord rules at phrase start: ${motifHarmonyBad.map((n) => n.note).join(', ')}`
    : null;

  const diagnostics = createDiagnostics();
  const slotVariants = [];
  const slotIssues = [];
  for (const layout of opts.slotLayout) {
    const built = buildSlotVariants({
      slot: layout,
      opts,
      motifEvents,
      diagnostics,
      slotStart: layout.start,
    });
    slotVariants.push({ layout, variants: built.variants });
    slotIssues.push(built.diagnostics);
  }

  const emptySlots = slotVariants.filter((s) => s.variants.length === 0);
  if (emptySlots.length) {
    const reasons = inputErrors.map((e) => e.message);
    for (const issue of slotIssues.filter((s) => s.total === 0)) {
      if (issue.cadenceConflict) {
        reasons.push(`${issue.slot}: ending conflict — ${issue.cadenceConflict.detail}`);
      }
    }
    reasons.push(`No derivable segment satisfies register, harmony and length budget for slot(s): ${emptySlots.map((s) => s.layout.role).join(', ')}`);
    if (opts.high - opts.low < 5) {
      reasons.push(`Register ${midiToPitch(opts.low)}–${midiToPitch(opts.high)} is too narrow for the motif's intervallic content; widen it or keep interval compression enabled.`);
    }
    if (opts.high - opts.low === 0) {
      reasons.push('Register collapses to a single pitch, so no transposition can be legal.');
    }
    for (const issue of slotIssues.filter((s) => s.total === 0 && !s.cadenceConflict)) {
      reasons.push(`${issue.slot}: every generated variant was rejected (${issue.inversionRejected} inversion repair(s) infeasible).`);
    }
    return failedResult('no-derivable-segments', motif, opts, diagnostics, slotIssues, {
      reasons, motifHarmonyWarning, inputErrors,
    });
  }

  // Combine slots by beam search; positions are structural, so scoring decides.
  const width = 64;
  let partials = [{ choices: [] }];
  for (let si = 0; si < slotVariants.length; si += 1) {
    const { variants } = slotVariants[si];
    const next = [];
    for (const p of partials) {
      for (const v of variants) {
        const used = new Set(p.choices.flatMap((c) => c.ops.map((o) => o.op)));
        const newOps = v.ops.filter((o) => !used.has(o.op)).length;
        next.push({
          choices: [...p.choices, v],
          score: p.choices.reduce((s, c) => s + c.baseQuality, 0) + v.baseQuality + newOps * 0.015,
        });
      }
    }
    next.sort((a, b) => (b.score - a.score)
      || seededKey(opts.seed, 'beam', si, JSON.stringify(a.choices.map((c) => c.transformKind)))
        .localeCompare(seededKey(opts.seed, 'beam', si, JSON.stringify(b.choices.map((c) => c.transformKind)))));
    const selected = [];
    const sigs = new Set();
    for (const p of next) {
      const sig = p.choices.map((c) => c.transformKind).join('|');
      if (sigs.has(sig) && selected.length < width * 0.7) continue;
      sigs.add(sig);
      selected.push(p);
      if (selected.length >= width) break;
    }
    partials = selected;
  }

  const filteredCandidates = [];
  for (const p of partials) {
    const phrase = assemblePhrase(p.choices, opts);
    phrase.segments = phrase.segments.map((s) => segmentProfile(s, opts));
    const constraints = evaluateConstraints(phrase, opts, opts.harmonyObj);
    if (!constraints.ok) continue;
    const style = styleScore(phrase, opts, opts.harmonyObj, constraints.classified);
    filteredCandidates.push({ phrase, constraints, style });
  }

  if (!filteredCandidates.length) {
    const failureCounts = {};
    let sampled = 0;
    for (const p of partials.slice(0, 200)) {
      const phrase = assemblePhrase(p.choices, opts);
      phrase.segments = phrase.segments.map((s) => segmentProfile(s, opts));
      const constraints = evaluateConstraints(phrase, opts, opts.harmonyObj);
      sampled += 1;
      constraints.violations.forEach((v) => {
        failureCounts[v.code] = failureCounts[v.code] ?? { count: 0, example: v.message };
        failureCounts[v.code].count += 1;
      });
    }
    const reasons = inputErrors.map((e) => e.message);
    reasons.push('No assembled phrase passed all hard constraints (register, harmony/non-chord rules, ending target, length, lineage).');
    Object.entries(failureCounts).forEach(([code, info]) => {
      reasons.push(`${code}: ${info.example} (${info.count}/${sampled} sampled phrases)`);
    });
    const endingFailure = failureCounts.ending;
    const logLines = Array.isArray(diagnostics) ? diagnostics : diagnostics.toArray();
    const candidateEndingConflicts = logLines.filter((d) => d.includes('cadence target'));
    if (endingFailure && candidateEndingConflicts.length) {
      reasons.unshift(`Ending conflict: ${candidateEndingConflicts[0]}`);
    } else if (endingFailure) {
      reasons.unshift(`Ending conflict: ${endingFailure.example}. No operation chain lands on the requested ending without violating another hard constraint.`);
    }
    return failedResult('no-candidate', motif, opts, diagnostics, slotIssues, {
      reasons,
      motifHarmonyWarning,
      inputErrors,
      counts: { assembled: partials.length, checked: sampled },
      failureCounts,
    });
  }

  filteredCandidates.sort((a, b) => {
    if (b.style.total !== a.style.total) return b.style.total - a.style.total;
    return seededKey(opts.seed, 'final', JSON.stringify(a.phrase.events.map((e) => [e.pitch, e.start, e.dur])))
      .localeCompare(seededKey(opts.seed, 'final', JSON.stringify(b.phrase.events.map((e) => [e.pitch, e.start, e.dur]))));
  });

  const candidates = filteredCandidates.slice(0, opts.candidateCount).map((c, i) => presentCandidate(c, i, opts, motifEvents));

  return {
    ok: true,
    motif,
    options: summariseOptions(opts),
    template: {
      id: opts.templateDef.id,
      name: opts.templateDef.name,
      description: opts.templateDef.description,
      slots: opts.slotLayout.map((s) => ({ role: s.role, label: s.label, start: s.start, budget: s.budget, bars: s.bars, cadence: s.cadence })),
      totalBars: opts.totalBars,
    },
    harmony: harmonyRows(opts),
    candidates,
    chosen: candidates[0],
    diagnostics: {
      inputErrors,
      reasons: [],
      slotIssues,
      motifHarmonyWarning,
      candidatePool: {
        assembled: partials.length,
        passedHardConstraints: filteredCandidates.length,
        returned: candidates.length,
      },
    },
    reproducibility: reproducibility(opts),
  };
}

function failedResult(reason, motif, opts, diagnostics, slotIssues, extra) {
  return {
    ok: false,
    reason,
    motif,
    options: summariseOptions(opts),
    template: {
      id: opts.templateDef.id,
      name: opts.templateDef.name,
      description: opts.templateDef.description,
      slots: opts.slotLayout.map((s) => ({ role: s.role, label: s.label, start: s.start, budget: s.budget, bars: s.bars, cadence: s.cadence })),
      totalBars: opts.totalBars,
    },
    harmony: harmonyRows(opts),
    diagnostics: {
      ...extra,
      log: Array.isArray(diagnostics) ? diagnostics : diagnostics.toArray(),
      slotIssues,
    },
    candidates: [],
    chosen: null,
    reproducibility: reproducibility(opts),
  };
}

function presentCandidate(c, i, opts, motifEvents) {
  const segments = c.phrase.segments.map((seg) => {
    const classification = c.constraints.classified.filter(
      (n) => n.start >= seg.slotStart - EPS && n.start < seg.slotStart + seg.slotBudget + EPS,
    );
    return {
      ...seg,
      classification,
      slotEnd: seg.slotStart + seg.slotBudget,
      verification: verifyPipeline({
        motifEvents,
        ops: seg.ops,
        actualEvents: seg.events.map((e) => ({ ...e, start: e.localStart })),
      }),
    };
  });
  return {
    id: `cand-${i + 1}`,
    rank: i + 1,
    segments,
    events: c.phrase.events,
    totalBeats: c.phrase.totalBeats,
    harmony: harmonyRows(opts),
    constraints: c.constraints,
    style: c.style,
    reproducibility: reproducibility(opts, c),
  };
}

function harmonyRows(opts) {
  const rows = [];
  for (let bar = 0; bar < opts.totalBars; bar += 1) {
    const start = bar * opts.beatsPerBar;
    const chord = chordAt(opts.harmonyObj, start);
    rows.push({
      bar: bar + 1,
      start,
      dur: opts.beatsPerBar,
      symbol: chord?.label ?? '—',
      pcs: chord?.pcs ?? [],
      rootPc: chord?.rootPc ?? null,
      quality: chord?.quality ?? null,
    });
  }
  return rows;
}

function reproducibility(opts, candidate) {
  return {
    engineVersion: ENGINE_VERSION,
    seed: opts.seed,
    seedHash: hashString(String(opts.seed)),
    configHash: hashString(JSON.stringify({
      key: opts.key,
      register: opts.register,
      meter: opts.meter,
      harmony: opts.harmony,
      ending: opts.ending,
      template: opts.template,
      allow: opts.allow,
      rhythmFactors: opts.rhythmFactors,
      nonChordRules: opts.nonChordRules,
      candidateCount: opts.candidateCount,
    })),
    motifHash: hashString(JSON.stringify(opts.motifEvents.map((e) => [e.pitch, e.start, e.dur]))),
    candidateHash: candidate
      ? hashString(JSON.stringify(candidate.phrase.events.map((e) => [e.pitch, e.start, e.dur])))
      : null,
    deterministic: true,
  };
}

function summariseOptions(opts) {
  return {
    key: { tonic: pcName(opts.tonicPc), mode: opts.key.mode },
    register: { low: midiToPitch(opts.low), high: midiToPitch(opts.high) },
    meter: opts.meter,
    tempo: opts.tempo,
    harmony: opts.harmony.slice(),
    ending: {
      pc: opts.endingPc == null ? null : pcName(opts.endingPc),
      low: midiToPitch(opts.endingLow),
      high: midiToPitch(opts.endingHigh),
      exactMidi: opts.endingExact,
    },
    template: opts.template,
    templateBars: opts.totalBars,
    totalBeats: opts.totalBeats,
    allow: { ...opts.allow },
    rhythmFactors: opts.rhythmFactors.slice(),
    nonChordRules: { ...opts.nonChordRules },
    candidateCount: opts.candidateCount,
    seed: opts.seed,
  };
}

/** Parse a compact melody string: "C4:1 E4:.5 G4:.5 A4:1". */
export function parseMotifText(text, { id = 'motif', name = 'Motif', defaultDur = 1 } = {}) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  const events = [];
  let start = 0;
  for (const token of tokens) {
    const [note, durText] = token.split(':');
    const dur = durText == null ? defaultDur : Number(durText);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error(`Invalid duration in token "${token}"`);
    events.push({ pitch: parsePitch(note), start, dur });
    start += dur;
  }
  return normalizeMotif({ id, name, events });
}

export default { generatePhrases, PHRASE_TEMPLATES, DEFAULT_OPTIONS, classifyNotes, resolveOptions, parseMotifText };

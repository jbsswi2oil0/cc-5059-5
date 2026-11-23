import { describe, it, expect } from 'vitest';
import {
  generatePhrases,
  parseMotifText,
  classifyNotes,
  PHRASE_TEMPLATES,
  resolveOptions,
} from '../src/music/generator.js';
import { applyPipeline, verifyPipeline } from '../src/music/ops.js';
import {
  invertEvents,
  retrogradeEvents,
  scaleRhythmEvents,
  contourSimilarity,
  resolveInversionRange,
  translate,
} from '../src/music/motif.js';
import { parsePitch, midiToPitch, pitchClass, makeHarmony, parseChord } from '../src/music/pitch.js';

const MOTIF_TEXT = 'C4:1 D4:0.5 E4:0.5 G4:1 E4:0.5 C4:0.5 D4:1';
const motif = () => parseMotifText(MOTIF_TEXT, { name: 'Test motif' });

describe('pitch fundamentals', () => {
  it('parses and prints scientific pitch', () => {
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('A4')).toBe(69);
    expect(parsePitch('F#3')).toBe(54);
    expect(parsePitch('Bb5')).toBe(82);
    expect(midiToPitch(60)).toBe('C4');
    expect(midiToPitch(61)).toBe('C#4');
  });

  it('parses chord symbols and builds a beat timeline', () => {
    expect(parseChord('C').pcs).toEqual([0, 4, 7]);
    expect(parseChord('Am7').pcs).toEqual([9, 0, 4, 7]);
    expect(parseChord('F#m7b5').pcs).toEqual([6, 9, 0, 4]);
    const h = makeHarmony(['C', 'Am'], { meter: [4, 4] });
    expect(h.chords).toHaveLength(2);
    expect(h.chords[1].start).toBe(4);
  });
});

describe('operations act on interval and rhythmic relations', () => {
  const events = motif().events;

  it('inversion mirrors intervals about an axis', () => {
    const inv = invertEvents(events, 60);
    for (let i = 1; i < events.length; i += 1) {
      expect(inv[i].pitch - inv[i - 1].pitch).toBe(-(events[i].pitch - events[i - 1].pitch));
    }
    expect(inv.map((e) => e.start)).toEqual(events.map((e) => e.start));
  });

  it('rhythmic expansion scales times without changing pitches or note count', () => {
    const stretched = scaleRhythmEvents(events, 2);
    expect(stretched.map((e) => e.pitch)).toEqual(events.map((e) => e.pitch));
    expect(stretched.map((e) => e.dur)).toEqual(events.map((e) => e.dur * 2));
    expect(stretched.map((e) => e.start)).toEqual(events.map((e) => e.start * 2));
  });

  it('retrograde reverses order while preserving pitch multiset', () => {
    const rev = retrogradeEvents(events);
    expect(rev.map((e) => e.pitch).sort()).toEqual(events.map((e) => e.pitch).sort());
    expect(rev[0].pitch).toBe(events[events.length - 1].pitch);
  });

  it('contour similarity scores an octave transposition as identical', () => {
    const up = translate(events, 12);
    expect(contourSimilarity(events, up).score).toBeCloseTo(1, 6);
  });
});

describe('lineage verification', () => {
  it('rejects a segment whose notes do not replay from its recorded ops', () => {
    const m = motif();
    const ops = [
      { op: 'fragment', params: { from: 0, to: 3 } },
      { op: 'diatonic-transpose', params: { degrees: 2, tonicPc: 0, mode: 'major' } },
    ];
    const actual = applyPipeline(m.events, ops);
    expect(verifyPipeline({ motifEvents: m.events, ops, actualEvents: actual }).ok).toBe(true);

    const tampered = actual.map((e, i) => (i === 1 ? { ...e, pitch: e.pitch + 1 } : e));
    const check = verifyPipeline({ motifEvents: m.events, ops, actualEvents: tampered });
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/expected pitch/);
  });

  it('every generated segment replays exactly from its ops, per candidate', () => {
    const result = generatePhrases(motif(), { seed: 'verify' });
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      for (const seg of cand.segments) {
        expect(seg.verification.ok).toBe(true);
        const replayed = applyPipeline(result.motif.events, seg.ops);
        expect(replayed.map((e) => e.pitch)).toEqual(seg.events.map((e) => e.pitch));
        expect(replayed.map((e) => e.dur)).toEqual(seg.events.map((e) => e.dur));
      }
    }
  });

  it('records source motif and operation for every segment', () => {
    const result = generatePhrases(motif(), { seed: 'lineage' });
    const cand = result.chosen;
    for (const seg of cand.segments) {
      expect(seg.source.id).toBe(result.motif.id);
      expect(seg.source.name).toBe(result.motif.name);
      expect(seg.sourceNoteRange.from).toBeGreaterThanOrEqual(0);
      expect(seg.sourceNoteRange.to).toBeLessThan(result.motif.events.length);
      expect(seg.opSummary.length).toBeGreaterThanOrEqual(0);
      expect(seg.lineage).toContain(result.motif.name);
      expect(seg.ops.every((o) => typeof o.op === 'string')).toBe(true);
    }
    // At least one segment must be an actual development, not a restatement.
    expect(cand.segments.some((s) => s.ops.some((o) => o.op !== 'fragment'))).toBe(true);
  });
});

describe('hard constraints vs stylistic scoring', () => {
  it('reports hard checks separately from style components', () => {
    const result = generatePhrases(motif(), { seed: 'sep' });
    const cand = result.chosen;
    expect(cand.constraints.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['register', 'harmony', 'ending', 'length', 'lineage', 'segments']),
    );
    expect(cand.constraints.checks.every((c) => typeof c.ok === 'boolean')).toBe(true);
    expect(cand.style.components.length).toBeGreaterThan(3);
    expect(cand.style.total).toBeGreaterThan(0);
    expect(cand.style.total).toBeLessThanOrEqual(1.001);
    // Hard data must not be inside the style score.
    expect(Object.keys(cand.style)).toEqual(['total', 'components']);
  });

  it('keeps every note within the declared register', () => {
    const result = generatePhrases(motif(), { register: { lowNote: 'C4', highNote: 'A5' }, seed: 'reg' });
    const low = parsePitch('C4');
    const high = parsePitch('A5');
    for (const e of result.chosen.events) {
      expect(e.pitch).toBeGreaterThanOrEqual(low);
      expect(e.pitch).toBeLessThanOrEqual(high);
    }
  });

  it('uses only declared passing/auxiliary non-chord tones, never filler', () => {
    const result = generatePhrases(motif(), { seed: 'nct' });
    for (const note of result.chosen.constraints.classified) {
      expect(['chord', 'passing', 'auxiliary']).toContain(note.type);
      if (note.type === 'passing' || note.type === 'auxiliary') {
        expect(note.dur).toBeLessThanOrEqual(1.5 + 1e-9);
        expect(note.reason).toMatch(/passing|auxiliary/);
      }
    }
  });

  it('rejects non-chord notes when the declared rules forbid them', () => {
    const m = motif();
    const harmony = makeHarmony(['C', 'C', 'C', 'C', 'C', 'C', 'C', 'C'], { meter: [4, 4] });
    const events = [
      { pitch: parsePitch('C4'), start: 0, dur: 1 },
      { pitch: parsePitch('C#4'), start: 1, dur: 1 },
      { pitch: parsePitch('G4'), start: 2, dur: 1 },
    ];
    const strict = classifyNotes(events, harmony, { passing: false, auxiliary: false, maxDur: 1 }, { beatsPerBar: 4 });
    expect(strict[1].type).toBe('unpermitted');
    const lenient = classifyNotes(events, harmony, { passing: true, auxiliary: true, maxDur: 1.5 }, { beatsPerBar: 4 });
    // C# between C and G is not a passing tone (not monotonic into G) and not an auxiliary.
    expect(lenient[1].type).toBe('unpermitted');
  });
});

describe('ending conflicts', () => {
  it('reports an explicit ending conflict when the target is not in the final chord', () => {
    const m = motif();
    // C major throughout, but the requested ending is D. D is neither a chord
    // tone of C (C E G) nor admissible as a phrase-final passing/auxiliary note,
    // so the ending target and the harmonic support are in direct conflict.
    const result = generatePhrases(m, {
      harmony: ['C'],
      ending: { pc: 'D', lowNote: 'D4', highNote: 'D5' },
      seed: 'conflict',
    });
    expect(result.ok).toBe(false);
    const text = result.diagnostics.reasons.join(' ');
    expect(text).toMatch(/ending conflict/i);
    expect(text).toMatch(/must end on D/);
    expect(text).toMatch(/C E G/);
    const conflict = result.diagnostics.slotIssues.find((s) => s.cadenceConflict)?.cadenceConflict;
    expect(conflict).toMatchObject({ targetPc: 'D', finalChord: 'C', chordTones: 'C E G' });
    expect(result.candidates).toHaveLength(0);
  });

  it('honours a locked exact ending pitch class', () => {
    const result = generatePhrases(motif(), {
      register: { lowNote: 'C4', highNote: 'E5' },
      ending: { exactMidi: parsePitch('C4'), lowNote: 'C4', highNote: 'C4' },
      allow: { inversion: true, retrograde: false, rhythm: true, diatonicTranspose: true },
      seed: 'locked',
    });
    expect(result.ok).toBe(true);
    expect(result.chosen.events.at(-1).pitch).toBe(parsePitch('C4'));
    const endingCheck = result.chosen.constraints.checks.find((c) => c.id === 'ending');
    expect(endingCheck.ok).toBe(true);
  });

  it('lands on the exact MIDI note (not just its pitch class) after cadence retargeting', () => {
    // This motif's cadential attempts all need an explicit retarget. The target
    // is C5 (72), not any octave of C; a retarget that only matched pitch class
    // could land on C4/C6 and still pass a pitch-class check.
    const m = parseMotifText('A4:1 G4:1 F4:1 E4:2', { name: 'fall' });
    const result = generatePhrases(m, {
      ending: { pc: 'C', lowNote: 'C4', highNote: 'C5', exactMidi: 72 },
      seed: 'exact-retarget',
    });
    expect(result.ok).toBe(true);
    for (const cand of result.candidates) {
      expect(cand.events.at(-1).pitch).toBe(72);
    }
  });

  it('names the real cause when cadential attempts fail the non-chord rules', () => {
    const m = parseMotifText('E4:0.5 G4:0.5 A4:1 G4:0.5 E4:0.5 D4:1', { name: 'x' });
    const result = generatePhrases(m, {
      harmony: ['C', 'Am', 'F', 'C'],
      template: 'three-phase',
      seed: 'theme-1',
    });
    expect(result.ok).toBe(false);
    const log = result.diagnostics.log.join(' ');
    expect(log).toMatch(/non-chord rules/);
    expect(log).not.toMatch(/slot budget/);
  });
});

describe('narrow registers', () => {
  it('refuses to generate and explains the register problem', () => {
    const result = generatePhrases(motif(), {
      register: { lowNote: 'C4', highNote: 'D4' },
      seed: 'narrow',
    });
    expect(result.ok).toBe(false);
    const text = result.diagnostics.reasons.join(' ');
    expect(text).toMatch(/too narrow|outside the selected register|rejected/i);
    expect(result.candidates).toHaveLength(0);
  });

  it('works again when the register is widened, proving the limit was real', () => {
    const narrow = generatePhrases(motif(), { register: { lowNote: 'C4', highNote: 'D4' }, seed: 'narrow' });
    const wide = generatePhrases(motif(), { register: { lowNote: 'C4', highNote: 'C6' }, seed: 'narrow' });
    expect(narrow.ok).toBe(false);
    expect(wide.ok).toBe(true);
  });
});

describe('inversion vs register arbitration', () => {
  it('chooses between octave transposition and interval compression by contour', () => {
    // Raw inversion sits well below the register; anchor note is pinned.
    const raw = [48, 50, 52, 47, 45, 48].map((p, i) => ({ pitch: p, start: i * 0.5, dur: 0.5 }));
    const resolution = resolveInversionRange({
      rawEvents: raw,
      sourceEvents: raw,
      low: parsePitch('C4'),
      high: parsePitch('A5'),
      ending: null,
    });
    expect(resolution.feasible).toBe(true);
    // Octave transposition preserves contour perfectly, so it should win here.
    expect(resolution.chosen.type).toBe('octave-transpose');
    const contourByType = Object.fromEntries(
      resolution.candidates.filter((c) => c.valid).map((c) => [c.type, c.contour.score]),
    );
    expect(contourByType['octave-transpose']).toBeGreaterThanOrEqual(contourByType['interval-compression'] ?? 0);
  });

  it('falls back to interval compression when whole-octave shifts overshoot the register', () => {
    // The inverted shape ends on the locked C4 but several earlier notes sit above
    // the register. Whole-octave shifts move the locked note off C4; local octave
    // correction cannot bring those notes down without leaving the register.
    // Compression toward the locked final note is the only repair that works.
    const raw = [64, 66, 69, 71, 60].map((p, i) => ({ pitch: p, start: i * 0.5, dur: 0.5 }));
    const resolution = resolveInversionRange({
      rawEvents: raw,
      sourceEvents: raw,
      low: parsePitch('C4'),
      high: parsePitch('F4'),
      ending: { exactMidi: parsePitch('C4') },
    });
    expect(resolution.feasible).toBe(true);
    expect(resolution.chosen.type).toBe('interval-compression');
    expect(resolution.chosen.events.at(-1).pitch).toBe(parsePitch('C4'));
    expect(resolution.chosen.events.every((e) => e.pitch >= parsePitch('C4') && e.pitch <= parsePitch('F4'))).toBe(true);
  });

  it('records the repair ops so the result still replays from the motif', () => {
    const result = generatePhrases(motif(), {
      register: { lowNote: 'C4', highNote: 'E5' },
      ending: { exactMidi: parsePitch('C4'), lowNote: 'C4', highNote: 'C4' },
      seed: 'repair',
    });
    expect(result.ok).toBe(true);
    const repaired = result.chosen.segments.filter((s) =>
      s.ops.some((o) => ['octave-shift', 'compress-intervals', 'local-octave'].includes(o.op)),
    );
    expect(repaired.length).toBeGreaterThan(0);
    for (const seg of result.chosen.segments) {
      expect(seg.verification.ok).toBe(true);
    }
  });
});

describe('determinism and reproducibility', () => {
  it('produces identical results for the same seed and config', () => {
    const a = generatePhrases(motif(), { seed: 'repeat' });
    const b = generatePhrases(motif(), { seed: 'repeat' });
    expect(a.chosen.events).toEqual(b.chosen.events);
    expect(a.chosen.reproducibility.candidateHash).toBe(b.chosen.reproducibility.candidateHash);
    expect(a.reproducibility.motifHash).toBe(b.reproducibility.motifHash);
    expect(a.reproducibility.configHash).toBe(b.reproducibility.configHash);
  });

  it('changes the phrasing when the seed changes but keeps it legal', () => {
    const a = generatePhrases(motif(), { seed: 'seed-a' });
    const b = generatePhrases(motif(), { seed: 'seed-b' });
    expect(a.ok && b.ok).toBe(true);
    expect(a.chosen.reproducibility.seedHash).not.toBe(b.chosen.reproducibility.seedHash);
    for (const r of [a, b]) {
      expect(r.chosen.constraints.ok).toBe(true);
    }
  });

  it('is not drawing from a library: changed motif produces changed materials', () => {
    const m1 = parseMotifText('C4:1 E4:1 G4:1 A4:1', { name: 'One' });
    const m2 = parseMotifText('C4:2 D4:1 E4:0.5 G4:0.5', { name: 'Two' });
    const r1 = generatePhrases(m1, { seed: 'lib' });
    const r2 = generatePhrases(m2, { seed: 'lib' });
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.chosen.events).not.toEqual(r2.chosen.events);
    // The first segment restates the motif's own opening.
    expect(r1.chosen.segments[0].events[0].pitch).toBe(m1.events[0].pitch);
    expect(r2.chosen.segments[0].events[0].pitch).toBe(m2.events[0].pitch);
  });
});

describe('phrase templates', () => {
  it('each template generates a legal phrase with its declared slot count', () => {
    for (const id of Object.keys(PHRASE_TEMPLATES)) {
      const result = generatePhrases(motif(), { template: id, seed: `tpl-${id}` });
      expect(result.ok, `template ${id}: ${(result.diagnostics.reasons ?? []).join('; ')}`).toBe(true);
      expect(result.chosen.segments).toHaveLength(PHRASE_TEMPLATES[id].slots.length);
      expect(result.chosen.constraints.ok).toBe(true);
      expect(result.chosen.events.at(-1).pitch % 12).toBe(0);
    }
  });

  it('the phrase is longer than the source motif', () => {
    const m = motif();
    const motifBeats = Math.max(...m.events.map((e) => e.start + e.dur));
    const result = generatePhrases(m, { seed: 'longer' });
    expect(result.chosen.totalBeats).toBeGreaterThan(motifBeats);
  });
});

describe('options validation', () => {
  it('rejects an inverted register', () => {
    expect(() => resolveOptions({ register: { lowNote: 'C5', highNote: 'C4' } })).toThrow(/above/);
  });

  it('rejects an unknown template', () => {
    expect(() => resolveOptions({ template: 'nope' })).toThrow(/Unknown phrase template/);
  });
});

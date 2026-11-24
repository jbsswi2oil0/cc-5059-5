import { describe, it, expect } from 'vitest';
import { generatePhrases, parseMotifText } from '../src/music/generator.js';
import { applyPipeline, verifyPipeline } from '../src/music/ops.js';
import { TransformSession } from '../src/music/session.js';
import { parsePitch } from '../src/music/pitch.js';

// Boundary regressions around transform repair: extreme registers, fractional
// durations, cadence-budget thresholds, and failure propagation. These pin the
// behavior discovered by the minimal-reproduction probes so a later change
// cannot silently delete notes, leak out-of-range pitches, or fake a pass.

describe('extreme register boundaries', () => {
  it('keeps every note inside an inclusive register that the motif exactly fills', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1 G4:1', { name: 'tight' });
    const r = generatePhrases(m, {
      register: { lowNote: 'C4', highNote: 'G5' },
      seed: 'bnd-reg',
    });
    expect(r.ok).toBe(true);
    for (const e of r.chosen.events) {
      expect(e.pitch).toBeGreaterThanOrEqual(parsePitch('C4'));
      expect(e.pitch).toBeLessThanOrEqual(parsePitch('G5'));
    }
  });

  it('fails honestly on a single-semitone-wide register instead of collapsing pitches', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1', { name: 'unison-only' });
    const r = generatePhrases(m, {
      register: { lowNote: 'C4', highNote: 'C4' },
      seed: 'bnd-unison',
    });
    expect(r.ok).toBe(false);
    expect(r.candidates).toHaveLength(0);
    // The failure names the structural cause; it never returns a phrase whose
    // distinct notes were silently merged onto the single legal pitch.
    expect(r.diagnostics.reasons.join(' ')).toMatch(/single pitch|too narrow/i);
  });

  it('never emits a note beyond the register even after inversion repair', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1 F4:1 G4:1', { name: 'leap' });
    const r = generatePhrases(m, {
      register: { lowNote: 'C4', highNote: 'F4' },
      ending: { exactMidi: 60, lowNote: 'C4', highNote: 'C4' },
      seed: 'bnd-invert',
    });
    // Whether or not a full phrase is feasible, any returned candidate must be legal.
    if (r.ok) {
      for (const cand of r.candidates) {
        for (const e of cand.events) {
          expect(e.pitch).toBeGreaterThanOrEqual(60);
          expect(e.pitch).toBeLessThanOrEqual(65);
        }
        for (const seg of cand.segments) expect(seg.verification.ok).toBe(true);
      }
    }
  });
});

describe('fractional duration and rhythm expansion', () => {
  const fracMotif = () => parseMotifText('C4:0.25 E4:0.25 G4:0.5 C5:0.75 E5:0.75', { name: 'frac' });

  it('preserves fractional durations and replays them through the recorded ops', () => {
    const r = generatePhrases(fracMotif(), {
      seed: 'bnd-frac',
      rhythmFactors: [1.5, 2, 2.5, 3, 0.75],
    });
    expect(r.ok).toBe(true);
    for (const seg of r.chosen.segments) {
      expect(seg.verification.ok).toBe(true);
      for (const e of seg.events) {
        // Every duration stays on a 1/16-beat grid.
        expect(Math.abs(e.dur * 16 - Math.round(e.dur * 16))).toBeLessThan(1e-6);
      }
    }
  });

  it('rejects expansion beyond the slot budget without dropping attacks', () => {
    const r = generatePhrases(fracMotif(), {
      seed: 'bnd-expand',
      rhythmFactors: [2.5, 3],
    });
    expect(r.ok).toBe(true);
    const motifNoteCount = fracMotif().events.length;
    for (const seg of r.chosen.segments) {
      const frag = seg.ops.find((o) => o.op === 'fragment');
      const expected = frag ? frag.params.to - frag.params.from + 1 : motifNoteCount;
      expect(seg.events.length).toBe(expected);
      const occupied = seg.events.at(-1).localStart + seg.events.at(-1).dur;
      expect(occupied).toBeLessThanOrEqual(seg.slotBudget * 0.92 + 1e-6);
    }
  });

  it('reports no derivable cadence when a short motif cannot expand into the final bar', () => {
    // 2-beat motif: even x3 = 6 beats, below the 8-beat cadence slot's 6.72 floor.
    const m = parseMotifText('C4:0.25 E4:0.25 G4:0.5 C5:0.75 E5:0.25', { name: 'too-short' });
    const r = generatePhrases(m, {
      seed: 'bnd-cadence',
      rhythmFactors: [1.5, 2, 2.5, 3],
    });
    expect(r.ok).toBe(false);
    const cadenceIssue = r.diagnostics.slotIssues.find((s) => s.slot === 'A″');
    expect(cadenceIssue.total).toBe(0);
    expect(r.diagnostics.log.join(' ')).toMatch(/cadential segment|slot budget/i);
  });
});

describe('failure propagation and evidence through the session', () => {
  it('a register failure blocks ending/duration checks from faking success', () => {
    const m = parseMotifText('C4:1 E4:1 G4:1', { name: 'm' });
    const session = new TransformSession(m.events, {
      register: { lowNote: 'C4', highNote: 'E4' },
      maxDuration: 4,
      ending: { exactMidi: 72 },
    });
    const result = session.apply({ op: 'transpose', params: { semitones: 12 } });
    expect(result.ok).toBe(false);
    // All violated boundaries are reported, not just the first one encountered.
    expect(result.violations).toEqual(expect.arrayContaining(['register', 'ending']));
    expect(session.current().map((e) => e.pitch)).toEqual([60, 64, 67]);
  });

  it('retains every rejected intermediate while the committed chain stays replayable', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    const session = new TransformSession(m.events, {
      register: { lowNote: 'C4', highNote: 'G4' },
      maxDuration: 6,
    });
    session.apply({ op: 'transpose', params: { semitones: 2 } }); // commits
    session.apply({ op: 'transpose', params: { semitones: 24 } }); // register fail
    session.apply({ op: 'rhythm', params: { factor: 3 } }); // duration fail (3 beats -> 9)
    expect(session.failures()).toHaveLength(2);
    expect(session.failures().map((f) => f.violations[0])).toEqual(['register', 'duration']);
    const replay = verifyPipeline({
      motifEvents: m.events,
      ops: session.committedOps(),
      actualEvents: session.current(),
    });
    expect(replay.ok).toBe(true);
    expect(session.committedOps()).toHaveLength(1);
  });

  it('does not reuse the prior ending anchor after rekey', () => {
    const m = parseMotifText('G4:1 A4:1 B4:1', { name: 'm' });
    const session = new TransformSession(m.events, {
      register: { lowNote: 'C4', highNote: 'A5' },
      ending: { exactMidi: parsePitch('C5') },
    });
    session.rekey({ ending: { exactMidi: parsePitch('G4') } });
    expect(session.constraints().ending.exactMidi).toBe(67);
    const result = session.apply({ op: 'cadence-target', params: { index: -1, pitch: 72 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('ending');
  });

  it('rejects a transform that changes the note count rather than silently accepting it', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1 G4:1', { name: 'm' });
    const session = new TransformSession(m.events, {
      register: { lowNote: 'C4', highNote: 'A5' },
    });
    // A fragment op removes notes: the session treats attack count as structural.
    const result = session.apply({ op: 'fragment', params: { from: 0, to: 1 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('note-count');
    expect(session.current().length).toBe(4);
  });
});

describe('pipeline repair ops stay deterministic at the boundary', () => {
  it('local-octave shifts replay exactly after a fragment', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1 F4:1 G4:1', { name: 'm' });
    const ops = [
      { op: 'fragment', params: { from: 1, to: 4 } },
      { op: 'local-octave', params: { shifts: [-12, -12, -12, -12] } },
    ];
    const events = applyPipeline(m.events, ops);
    const verify = verifyPipeline({ motifEvents: m.events, ops, actualEvents: events });
    expect(verify.ok).toBe(true);
    expect(events.every((e) => e.pitch < 65)).toBe(true);
  });

  it('rejects stale local-octave shift counts instead of indexing undefined notes', () => {
    const m = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    expect(() => applyPipeline(m.events, [
      { op: 'fragment', params: { from: 0, to: 1 } },
      { op: 'local-octave', params: { shifts: [12, 12, 12] } },
    ])).toThrow(/local-octave needs 2 shifts/);
  });
});

import { describe, it, expect } from 'vitest';
import { parseMotifText } from '../src/music/generator.js';
import { TransformSession } from '../src/music/session.js';
import { verifyPipeline } from '../src/music/ops.js';
import { midiToPitch } from '../src/music/pitch.js';

const bounds = (lowNote, highNote) => ({ lowNote, highNote });

describe('transform session: rollback transaction', () => {
  it('commits a legal transform and grows the phrase log by one entry', () => {
    const motif = parseMotifText('C4:1 D4:1 E4:1 G4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'A5') });
    const result = session.apply({ op: 'transpose', params: { semitones: 2 } });
    expect(result.ok).toBe(true);
    expect(result.events.map((e) => e.pitch)).toEqual([62, 64, 66, 69]);
    expect(session.log).toHaveLength(2);
    expect(session.log[1].op.op).toBe('transpose');
    expect(session.log[1].committed).toBe(true);
  });

  it('rejects a transform that leaves the register and keeps the last audible version', () => {
    const motif = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'E4') });
    const before = session.current().map((e) => e.pitch);
    const result = session.apply({ op: 'transpose', params: { semitones: 12 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('register');
    // The failed step is recorded as reversed, not committed.
    expect(session.log.at(-1).committed).toBe(false);
    expect(session.log.at(-1).reversed).toBe(true);
    // Current events are unchanged: the previous listenable version survives.
    expect(session.current().map((e) => e.pitch)).toEqual(before);
    // The failure evidence keeps the rejected intermediate for inspection.
    expect(result.intermediate.some((e) => e.pitch > 64)).toBe(true);
  });

  it('rolls back a rhythm expansion that overshoots the duration budget without deleting notes', () => {
    const motif = parseMotifText('C4:0.25 D4:0.25 E4:0.5', { name: 'fractional' });
    const session = new TransformSession(motif.events, {
      register: bounds('C4', 'A5'),
      maxDuration: 4,
    });
    const noteCountBefore = session.current().length;
    const result = session.apply({ op: 'rhythm', params: { factor: 5 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('duration');
    expect(session.current().length).toBe(noteCountBefore);
    // No note was removed to make the expansion fit: durations are the originals.
    expect(session.current().map((e) => e.dur)).toEqual([0.25, 0.25, 0.5]);
    expect(session.log.at(-1).reversed).toBe(true);
  });

  it('accepts a fractional expansion that stays inside the budget and replays exactly', () => {
    const motif = parseMotifText('C4:0.25 E4:0.25 G4:0.5 C5:0.75 E5:0.25', { name: 'frac' });
    const session = new TransformSession(motif.events, {
      register: bounds('C4', 'A5'),
      maxDuration: 8,
    });
    const result = session.apply({ op: 'rhythm', params: { factor: 1.5 } });
    expect(result.ok).toBe(true);
    expect(session.current().map((e) => e.dur)).toEqual([0.375, 0.375, 0.75, 1.125, 0.375]);
    const replay = verifyPipeline({
      motifEvents: motif.events,
      ops: session.committedOps(),
      actualEvents: session.current(),
    });
    expect(replay.ok).toBe(true);
  });

  it('rejects a transform that misses the locked ending target', () => {
    const motif = parseMotifText('C4:1 E4:1 G4:1', { name: 'm' });
    const session = new TransformSession(motif.events, {
      register: bounds('C4', 'A5'),
      ending: { exactMidi: 67 },
    });
    const result = session.apply({ op: 'transpose', params: { semitones: 2 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('ending');
    expect(session.current().at(-1).pitch).toBe(67);
  });

  it('supports an undo chain that restores every previous listenable version', () => {
    const motif = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'A5') });
    session.apply({ op: 'transpose', params: { semitones: 2 } });
    session.apply({ op: 'transpose', params: { semitones: 2 } });
    expect(session.current().map((e) => e.pitch)).toEqual([64, 66, 68]);
    expect(session.undo().map((e) => e.pitch)).toEqual([62, 64, 66]);
    expect(session.undo().map((e) => e.pitch)).toEqual([60, 62, 64]);
    expect(session.undo()).toBeNull();
  });

  it('undo after a failed transform removes the failure entry without touching committed work', () => {
    const motif = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'A5') });
    session.apply({ op: 'transpose', params: { semitones: 2 } }); // commits
    const shifted = session.current().map((e) => e.pitch);
    session.apply({ op: 'transpose', params: { semitones: 24 } }); // rolls back
    expect(session.failures()).toHaveLength(1);
    // The first undo must consume the rejected step, leaving the committed version.
    expect(session.undo().map((e) => e.pitch)).toEqual(shifted);
    expect(session.failures()).toHaveLength(0);
    // The next undo then removes the genuinely committed transform.
    expect(session.undo().map((e) => e.pitch)).toEqual([60, 62, 64]);
  });

  it('re-keys the session without reusing the previous ending anchor', () => {
    const motif = parseMotifText('G4:1 A4:1 B4:1', { name: 'm' });
    const session = new TransformSession(motif.events, {
      register: bounds('C4', 'A5'),
      ending: { pc: 0, low: 60, high: 72 },
    });
    // First ending anchor locks C.
    expect(session.constraints().ending.pc).toBe(0);
    session.rekey({ ending: { pc: 7, low: 55, high: 79 } });
    const next = session.constraints().ending;
    expect(next.pc).toBe(7);
    expect(next.low).toBe(55);
    expect(next.high).toBe(79);
    // A transform landing on the old anchor C must now fail the new G target.
    const result = session.apply({ op: 'cadence-target', params: { index: -1, pitch: 60 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('ending');
  });

  it('keeps failed-transform evidence while leaving the committed chain replayable', () => {
    const motif = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'D4') });
    const failed = session.apply({ op: 'transpose', params: { semitones: 5 } });
    expect(failed.ok).toBe(false);
    expect(session.failures()).toHaveLength(1);
    expect(session.failures()[0].violations).toEqual(['register']);
    expect(session.failures()[0].intermediate.map((e) => e.pitch)).toEqual([65, 67, 69]);
    const replay = verifyPipeline({
      motifEvents: motif.events,
      ops: session.committedOps(),
      actualEvents: session.current(),
    });
    expect(replay.ok).toBe(true);
  });

  it('treats register bounds as inclusive at the exact limit', () => {
    // A motif whose top note lands exactly on the high bound after shifting.
    const motif = parseMotifText('C4:1 C#4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'E4') });
    // C#4 + 3 = E4 (64), exactly the high bound; C4 + 3 = D#4, still inside.
    const result = session.apply({ op: 'transpose', params: { semitones: 3 } });
    expect(result.ok).toBe(true);
    expect(session.current().at(-1).pitch).toBe(64);
  });

  it('replays a committed chain containing a repair op note-for-note', () => {
    // Motif whose +7 shift overshoots only through its top notes, so the lower
    // notes stay legal and a follow-up repair transform can be committed.
    const motif = parseMotifText('C4:1 D4:1 E4:1', { name: 'm' });
    const session = new TransformSession(motif.events, { register: bounds('C4', 'B4') });
    // E4+7=B4 is legal, but G4 would not exist; use +8 so E4->C5 exceeds B4.
    const rejected = session.apply({ op: 'transpose', params: { semitones: 8 } });
    expect(rejected.ok).toBe(false);
    expect(rejected.violations).toContain('register');
    expect(session.current().every((e) => e.pitch <= 71)).toBe(true);
    // A legal transform then commits and the whole chain replays exactly.
    const repaired = session.apply({ op: 'transpose', params: { semitones: 2 } });
    expect(repaired.ok).toBe(true);
    const replay = verifyPipeline({
      motifEvents: motif.events,
      ops: session.committedOps(),
      actualEvents: session.current(),
    });
    expect(replay.ok).toBe(true);
    expect(session.current().map((e) => e.pitch)).toEqual([62, 64, 66]);
  });
});

// Transactional motif development session.
//
// Every transform is staged against the current listenable version first. If
// the intermediate result violates a hard boundary (register, total duration,
// locked ending) the transaction is reversed: the previous events stay in
// place and the rejected intermediate is retained as failure evidence. A
// transform never shortens a phrase by deleting out-of-range notes.

import { applyPipeline } from './ops.js';
import { parsePitch, parsePitchClass, pitchClass } from './pitch.js';

const EPS = 1e-6;

function asMidi(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? parsePitch(value) : value;
}

function durationOf(events) {
  return events.reduce((m, e) => Math.max(m, e.start + e.dur), 0);
}

function normalizeRegister(register = {}) {
  return {
    low: asMidi(register.low ?? register.lowNote, 0),
    high: asMidi(register.high ?? register.highNote, 127),
  };
}

function normalizeEnding(ending) {
  if (!ending) return null;
  const pc = ending.pc == null
    ? null
    : typeof ending.pc === 'string' ? parsePitchClass(ending.pc) : ending.pc;
  return {
    exactMidi: ending.exactMidi ?? null,
    pc,
    low: asMidi(ending.low ?? ending.lowNote, null),
    high: asMidi(ending.high ?? ending.highNote, null),
  };
}

function endingMatch(pitch, ending) {
  if (!ending) return true;
  if (ending.exactMidi != null) return pitch === ending.exactMidi;
  if (ending.pc != null) {
    if (pitchClass(pitch) !== ((ending.pc % 12) + 12) % 12) return false;
    if (ending.low != null && pitch < ending.low) return false;
    if (ending.high != null && pitch > ending.high) return false;
  }
  return true;
}

export class TransformSession {
  /**
   * @param {Array} baseEvents motif events, the immutable transaction origin
   * @param {object} constraints { register:{low,high}, maxDuration, ending }
   */
  constructor(baseEvents, constraints = {}) {
    this.baseEvents = baseEvents.map((e) => ({ ...e }));
    this.constraintState = {
      register: normalizeRegister(constraints.register),
      maxDuration: constraints.maxDuration ?? null,
      ending: normalizeEnding(constraints.ending),
    };
    this.versions = [this.baseEvents.map((e) => ({ ...e }))];
    this.log = [{ kind: 'origin', op: null, committed: true, reversed: false, events: this.versions[0] }];
    this.failureLog = [];
  }

  constraints() {
    return {
      register: { ...this.constraintState.register },
      maxDuration: this.constraintState.maxDuration,
      ending: this.constraintState.ending ? { ...this.constraintState.ending } : null,
    };
  }

  current() {
    return this.versions.at(-1).map((e) => ({ ...e }));
  }

  /** Ops of every committed step, in order, replayable from the motif. */
  committedOps() {
    return this.log.filter((entry) => entry.committed && entry.op).map((entry) => entry.op);
  }

  failures() {
    return this.failureLog.map((f) => ({ ...f, intermediate: f.intermediate.map((e) => ({ ...e })) }));
  }

  /**
   * Stage and validate one transform. On success the intermediate becomes the
   * new current version; on failure it is reversed and kept as evidence.
   */
  apply(op) {
    const previous = this.current();
    let intermediate;
    try {
      intermediate = applyPipeline(previous, [op]);
    } catch (err) {
      return this._reject(op, previous, [], `pipeline rejected: ${err.message}`);
    }

    const violations = this._check(previous, intermediate);
    if (violations.length) {
      return this._reject(op, previous, intermediate, null, violations);
    }

    this.versions.push(intermediate);
    this.log.push({ kind: 'transform', op, committed: true, reversed: false, events: intermediate });
    return { ok: true, events: intermediate.map((e) => ({ ...e })), violations: [] };
  }

  /**
   * Pop the last log entry. A trailing failed transform is discarded without
   * touching committed versions; otherwise the last committed version is
   * removed. Returns the current events, or null at the origin.
   */
  undo() {
    const last = this.log.at(-1);
    if (!last || (this.versions.length <= 1 && (!last || last.kind === 'origin'))) return null;
    if (last && !last.committed) {
      this.log.pop();
      const idx = this.failureLog.indexOf(last);
      if (idx >= 0) this.failureLog.splice(idx, 1);
      return this.current();
    }
    if (this.versions.length <= 1) return null;
    this.versions.pop();
    for (let i = this.log.length - 1; i >= 0; i -= 1) {
      if (this.log[i].committed && this.log[i].op) {
        this.log.splice(i, 1);
        break;
      }
    }
    return this.current();
  }

  /**
   * Replace active constraints (e.g. re-keying). The ending anchor is rebuilt
   * from the supplied state, so a stale target from the previous key never
   * carries over. Existing committed events are re-validated against the new
   * boundaries and reported, but never silently deleted.
   */
  rekey(next = {}) {
    this.constraintState = {
      register: normalizeRegister(next.register ?? this.constraintState.register),
      maxDuration: next.maxDuration ?? this.constraintState.maxDuration,
      ending: next.ending === undefined ? this.constraintState.ending : normalizeEnding(next.ending),
    };
    const violations = this._check(this.baseEvents, this.current());
    this.log.push({ kind: 'rekey', op: null, committed: true, reversed: false, constraints: this.constraints() });
    return { ok: violations.length === 0, violations, events: this.current() };
  }

  _check(previous, events) {
    const { register, maxDuration, ending } = this.constraintState;
    const violations = [];
    if (events.some((e) => e.pitch < register.low || e.pitch > register.high)) {
      violations.push('register');
    }
    if (maxDuration != null && durationOf(events) > maxDuration + EPS) {
      violations.push('duration');
    }
    if (ending && events.length && !endingMatch(events.at(-1).pitch, ending)) {
      violations.push('ending');
    }
    // A transform must never invent or drop attacks; note count is structural.
    if (previous.length && events.length !== previous.length) {
      violations.push('note-count');
    }
    return violations;
  }

  _reject(op, previous, intermediate, message, violations = ['pipeline']) {
    const entry = {
      kind: 'transform',
      op,
      committed: false,
      reversed: true,
      violations,
      message,
      intermediate: intermediate.map((e) => ({ ...e })),
    };
    this.log.push(entry);
    this.failureLog.push(entry);
    return {
      ok: false,
      violations,
      message,
      intermediate: entry.intermediate,
      events: previous.map((e) => ({ ...e })),
    };
  }
}

export default { TransformSession };

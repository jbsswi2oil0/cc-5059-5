// Motif representation and operations.
// Every operation is a pure function over events; it never invents notes.
// Events are { pitch, start, dur } with beats relative to the segment start.

export function normalizeMotif(input) {
  const events = input.events.map((e) => ({
    pitch: Math.round(e.pitch),
    start: Number(e.start),
    dur: Math.max(0.0625, Number(e.dur)),
    ...(e.role ? { role: e.role } : {}),
    ...(e.fromMotif ? { fromMotif: e.fromMotif } : {}),
  }));
  events.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].start < events[i - 1].start + events[i - 1].dur - 1e-9) {
      throw new Error(`Motif notes overlap at index ${i}`);
    }
  }
  return {
    id: input.id ?? 'motif',
    name: input.name ?? 'Motif',
    events,
    totalDur: events.reduce((m, e) => Math.max(m, e.start + e.dur), 0),
    key: input.key ?? null,
    meter: input.meter ?? [4, 4],
  };
}

export function eventIntervals(events) {
  const out = [];
  for (let i = 1; i < events.length; i += 1) out.push(events[i].pitch - events[i - 1].pitch);
  return out;
}

export function eventDurs(events) {
  return events.map((e) => e.dur);
}

function shiftStarts(events) {
  const t0 = events.length ? Math.min(...events.map((e) => e.start)) : 0;
  return events.map((e) => ({ ...e, start: roundBeat(e.start - t0) }));
}

function roundBeat(v) {
  return Math.round(v * 1e6) / 1e6;
}

export function translate(events, semitones) {
  return events.map((e) => ({ ...e, pitch: e.pitch + semitones }));
}

/** Chromatic mirror around an axis pitch. Interval i becomes -i. */
export function invertEvents(events, axis) {
  return events.map((e) => ({ ...e, pitch: Math.round(2 * axis - e.pitch) }));
}

/** Reverse order in time, keeping each note's duration. */
export function retrogradeEvents(events) {
  if (!events.length) return [];
  const span = Math.max(...events.map((e) => e.start + e.dur));
  const reversed = events
    .map((e) => ({ ...e, start: roundBeat(span - (e.start + e.dur)) }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return reversed;
}

/** Multiply note starts and durations; does not add or remove attacks. */
export function scaleRhythmEvents(events, factor) {
  if (!(factor > 0)) throw new Error('Rhythm factor must be positive');
  return events.map((e) => ({
    ...e,
    start: roundBeat(e.start * factor),
    dur: roundBeat(e.dur * factor),
  }));
}

export function fragmentEvents(events, fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex >= events.length || fromIndex > toIndex) {
    throw new Error(`Invalid fragment ${fromIndex}..${toIndex} of ${events.length} notes`);
  }
  const slice = events.slice(fromIndex, toIndex + 1);
  return shiftStarts(slice);
}

/** Compress pitch intervals toward an anchor note, keeping the anchor fixed. */
export function compressIntervalsEvents(events, factor, anchorIndex = events.length - 1) {
  const anchor = events[anchorIndex];
  if (!anchor) throw new Error('Interval compression needs an anchor note');
  return events.map((e) => ({
    ...e,
    pitch: Math.round(anchor.pitch + (e.pitch - anchor.pitch) * factor),
  }));
}

/** Displace just the notes that fall outside the register, by octaves. */
export function octaveCorrectEvents(events, low, high, { fixedIndex = -1 } = {}) {
  return events.map((e, i) => {
    if (i === fixedIndex) return { ...e };
    if (e.pitch >= low && e.pitch <= high) return { ...e };
    const options = [];
    for (let k = -4; k <= 4; k += 1) {
      const p = e.pitch + 12 * k;
      if (p < low || p > high) continue;
      options.push({ p, d: Math.abs(p - e.pitch) });
    }
    if (!options.length) return { ...e };
    options.sort((a, b) => a.d - b.d || a.p - b.p);
    return { ...e, pitch: options[0].p };
  });
}

export function rms(values) {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

function pearson(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 && db === 0) return 1;
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Contour preservation between two pitch sequences, in [0,1].
 * 60% direction/shape agreement (Pearson correlation of successive intervals),
 * 40% interval-magnitude retention.
 * An octave transposition scores 1; uniform interval compression scores 0.4 + 0.6*ratio.
 */
export function contourSimilarity(aEvents, bEvents) {
  const ia = eventIntervals(aEvents);
  const ib = eventIntervals(bEvents);
  const n = Math.min(ia.length, ib.length);
  if (n === 0) return { score: 1, shape: 1, magnitude: 1 };
  const a = ia.slice(0, n);
  const b = ib.slice(0, n);
  const r = pearson(a, b);
  let shape;
  if (r === null) shape = a[0] === b[0] ? 1 : 0.5;
  else shape = (r + 1) / 2;
  const ra = rms(a);
  const rb = rms(b);
  const magnitude = ra === 0 && rb === 0 ? 1 : 1 - Math.abs(ra - rb) / Math.max(ra, rb, 1);
  const score = Math.max(0, Math.min(1, 0.6 * shape + 0.4 * magnitude));
  return { score, shape, magnitude };
}

/**
 * Resolve an inversion that leaves the register while the final note is locked.
 * Enumerates whole-segment octave transpositions, local octave correction, and
 * interval compression, then picks by contour preservation. Deterministic.
 */
export function resolveInversionRange({
  rawEvents,
  sourceEvents,
  low,
  high,
  ending = null,
  compressionFactors = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45],
}) {
  const endingIndex = rawEvents.length - 1;
  const candidates = [];

  const endingOk = (evs) => {
    if (!ending) return true;
    const last = evs[evs.length - 1];
    if (!last) return false;
    if (ending.exactMidi != null) return last.pitch === ending.exactMidi;
    if (ending.pc != null) {
      if (((last.pitch % 12) + 12) % 12 !== ((ending.pc % 12) + 12) % 12) return false;
      if (ending.low != null && last.pitch < ending.low) return false;
      if (ending.high != null && last.pitch > ending.high) return false;
      return true;
    }
    return true;
  };
  const inRange = (evs) => evs.every((e) => e.pitch >= low && e.pitch <= high);
  const consider = (type, params, events, note) => {
    const valid = inRange(events) && endingOk(events);
    const contour = contourSimilarity(rawEvents, events);
    candidates.push({
      type,
      params,
      events,
      valid,
      contour,
      reason: note,
    });
  };

  // 1. Whole-segment octave transposition.
  for (let k = -3; k <= 3; k += 1) {
    if (k === 0) continue;
    consider(
      'octave-transpose',
      { semitones: 12 * k },
      translate(rawEvents, 12 * k),
      `${k > 0 ? 'up' : 'down'} ${Math.abs(k)} octave(s)`,
    );
  }

  // 2. Local octave correction of out-of-range notes only.
  consider(
    'local-octave',
    { low, high },
    octaveCorrectEvents(rawEvents, low, high, { fixedIndex: endingIndex }),
    'move only offending notes by octaves; locked final note untouched',
  );

  // 3. Interval compression anchored on the locked final note.
  for (const factor of compressionFactors) {
    const evs = compressIntervalsEvents(rawEvents, factor, endingIndex);
    consider(
      'interval-compression',
      { factor, anchorIndex: endingIndex },
      evs,
      `shorten intervals to ${Math.round(factor * 100)}% around locked final note`,
    );
  }

  // 4. Compression anchored on the first note, then local octave correction.
  for (const factor of [0.8, 0.65, 0.5]) {
    const evs = octaveCorrectEvents(
      compressIntervalsEvents(rawEvents, factor, 0),
      low,
      high,
      { fixedIndex: endingIndex },
    );
    consider(
      'compress+local-octave',
      { factor, anchorIndex: 0, low, high },
      evs,
      `compress to ${Math.round(factor * 100)}% from first note, then correct octaves`,
    );
  }

  const valid = candidates.filter((c) => c.valid);
  const ranked = (valid.length ? valid : candidates).slice().sort((a, b) => {
    if (b.contour.score !== a.contour.score) return b.contour.score - a.contour.score;
    const order = { 'octave-transpose': 0, 'interval-compression': 1, 'local-octave': 2, 'compress+local-octave': 3 };
    return order[a.type] - order[b.type];
  });
  return {
    feasible: valid.length > 0,
    chosen: ranked[0] ?? null,
    candidates: candidates.sort((a, b) => b.contour.score - a.contour.score),
    sourceSimilarity: sourceEvents ? contourSimilarity(sourceEvents, rawEvents) : null,
  };
}

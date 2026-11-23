// Pitch, scale and chord primitives. MIDI 60 = C4.

export const PC_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const PC_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL = { '#': 1, '♯': 1, b: -1, '♭': -1 };

/** Parse a note name such as C4, F#3, Bb5 into MIDI. */
export function parsePitch(text) {
  const m = String(text).trim().match(/^([A-Ga-g])([#b♯♭]?)(-?\d+)$/);
  if (!m) throw new Error(`Invalid pitch: "${text}"`);
  const [, letter, accidental, octave] = m;
  const pc = (LETTER_PC[letter.toUpperCase()] + (ACCIDENTAL[accidental] ?? 0) + 12) % 12;
  const midi = (Number(octave) + 1) * 12 + pc;
  if (midi < 0 || midi > 127) throw new Error(`Pitch out of MIDI range: ${text}`);
  return midi;
}

export function midiToPitch(midi, { flats = false } = {}) {
  const m = Math.round(midi);
  const octave = Math.floor(m / 12) - 1;
  return `${(flats ? PC_NAMES_FLAT : PC_NAMES_SHARP)[((m % 12) + 12) % 12]}${octave}`;
}

export function pitchClass(midi) {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function pcName(pc, { flats = false } = {}) {
  return (flats ? PC_NAMES_FLAT : PC_NAMES_SHARP)[((pc % 12) + 12) % 12];
}

/** Parse a pitch-class name without an octave, e.g. "F#" or "Bb". */
export function parsePitchClass(text) {
  const m = String(text).trim().match(/^([A-Ga-g])([#b♯♭]?)$/);
  if (!m) throw new Error(`Invalid pitch class: "${text}"`);
  const [, letter, accidental] = m;
  return (LETTER_PC[letter.toUpperCase()] + (ACCIDENTAL[accidental] ?? 0) + 12) % 12;
}

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

export function scalePitchClasses(tonicPc, mode = 'major') {
  const scale = SCALES[mode];
  if (!scale) throw new Error(`Unknown mode: ${mode}`);
  return scale.map((s) => (tonicPc + s) % 12);
}

/** Snap a MIDI pitch to the nearest member of a scale, staying in range. */
export function snapToScale(midi, tonicPc, mode, { low = 0, high = 127 } = {}) {
  const pcs = new Set(scalePitchClasses(tonicPc, mode));
  let best = null;
  for (let p = low; p <= high; p += 1) {
    if (!pcs.has(pitchClass(p))) continue;
    const d = Math.abs(p - midi);
    if (!best || d < best.d) best = { p, d };
  }
  return best ? best.p : midi;
}

export const CHORD_QUALITIES = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
};

/**
 * Parse a chord symbol: C, Am, F#m7, Bb7, Gsus4, Ddim, Eaug.
 * Returns { rootPc, quality, pcs, label }.
 */
export function parseChord(symbol) {
  const m = String(symbol).trim().match(/^([A-Ga-g])([#b♯♭]?)(.*)$/);
  if (!m) throw new Error(`Invalid chord: "${symbol}"`);
  const rootPc = parsePitchClass(m[1] + m[2]);
  let quality = m[3].trim();
  const aliases = {
    '': 'maj',
    M: 'maj',
    maj: 'maj',
    m: 'min',
    min: 'min',
    '-': 'min',
    dim: 'dim',
    '°': 'dim',
    o: 'dim',
    aug: 'aug',
    '+': 'aug',
    sus2: 'sus2',
    sus4: 'sus4',
    sus: 'sus4',
    7: '7',
    dom7: '7',
    maj7: 'maj7',
    M7: 'maj7',
    m7: 'min7',
    min7: 'min7',
    '-7': 'min7',
    m7b5: 'm7b5',
    dim7: 'dim7',
  };
  quality = aliases[quality] ?? aliases[quality.replace(/\s+/g, '')];
  if (!quality) throw new Error(`Unknown chord quality in "${symbol}"`);
  const pcs = CHORD_QUALITIES[quality].map((i) => (rootPc + i) % 12);
  return { rootPc, quality, pcs, label: symbol.trim() };
}

/** Build a beat-based chord timeline from a list of bar symbols. */
export function makeHarmony(barChords, { meter = [4, 4], tempo = 100, repeats = 1 } = {}) {
  const [num, den] = meter;
  const beatsPerBar = num * (4 / den);
  const chords = [];
  let beat = 0;
  for (let r = 0; r < repeats; r += 1) {
    for (const symbol of barChords) {
      const parsed = parseChord(symbol);
      chords.push({ ...parsed, start: beat, dur: beatsPerBar });
      beat += beatsPerBar;
    }
  }
  return { chords, beatsPerBar, totalBeats: beat, tempo, meter };
}

export function chordAt(harmony, beat) {
  for (const c of harmony.chords) {
    if (beat >= c.start - 1e-9 && beat < c.start + c.dur - 1e-9) return c;
  }
  return harmony.chords[harmony.chords.length - 1] ?? null;
}

export function harmonyPitchClasses(harmony, start, end) {
  const set = new Set();
  for (const c of harmony.chords) {
    if (c.start < end && c.start + c.dur > start) {
      for (const pc of c.pcs) set.add(pc);
    }
  }
  return set;
}

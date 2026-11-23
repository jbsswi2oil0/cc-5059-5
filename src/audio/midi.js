// Standard MIDI File (format 1) export, written by hand so the bytes are
// deterministic and inspectable. Events exported are exactly the phrase events
// shown in the UI; no re-quantising or note invention happens here.

const TICKS_PER_QUARTER = 480;

function varLen(value) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function str(text) {
  return [...text].map((c) => c.charCodeAt(0));
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u16(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function meta(type, data) {
  return [0xff, type, ...varLen(data.length), ...data];
}

function track(events, name) {
  // events: { beat, bytes:[...] }, converted to delta-time absolute ordering.
  const sorted = events
    .map((e, i) => ({ ...e, order: i }))
    .sort((a, b) => a.beat - b.beat || a.order - b.order);
  const out = [];
  out.push(...varLen(0), ...meta(0x03, str(name)));
  let lastTicks = 0;
  for (const e of sorted) {
    const ticks = Math.round(e.beat * TICKS_PER_QUARTER);
    out.push(...varLen(ticks - lastTicks), ...e.bytes);
    lastTicks = ticks;
  }
  out.push(...varLen(0), 0xff, 0x2f, 0x00);
  return out;
}

/**
 * @param {object} phrase candidate with { events, harmony }
 * @param {object} options { tempo, beatsPerBar, melodyChannel, includeHarmony, includeMotif, motif }
 * @returns {Uint8Array}
 */
export function phraseToMidi(phrase, options = {}) {
  const tempo = options.tempo ?? 96;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const melodyChannel = options.melodyChannel ?? 0;
  const chunk = [];

  // Header: format 1, two or three tracks, 480 ticks/quarter.
  chunk.push(...str('MThd'), ...u32(6), ...u16(1), ...u16(options.includeMotif ? 3 : 2), ...u16(TICKS_PER_QUARTER));

  const tempoUsPerQuarter = Math.round(60000000 / tempo);
  const tempoTrackEvents = [
    { beat: 0, bytes: meta(0x51, [(tempoUsPerQuarter >> 16) & 0xff, (tempoUsPerQuarter >> 8) & 0xff, tempoUsPerQuarter & 0xff]) },
    { beat: 0, bytes: meta(0x58, [beatsPerBar, Math.log2(4), 24, 8]) },
    { beat: 0, bytes: meta(0x03, str('Conductor')) },
  ];
  const tempoTrack = track(tempoTrackEvents, 'Conductor');

  // Melody track.
  const melodyEvents = [];
  for (const e of phrase.events) {
    const vel = e.velocity ?? 96;
    melodyEvents.push({ beat: e.start, bytes: [0x90 | melodyChannel, e.pitch, vel] });
    melodyEvents.push({ beat: e.start + e.dur * 0.98, bytes: [0x80 | melodyChannel, e.pitch, 0] });
  }
  const melodyTrack = track(melodyEvents, 'Phrase melody');

  // Optional harmony track.
  const harmonyEvents = [];
  if (options.includeHarmony) {
    for (const row of phrase.harmony ?? []) {
      const pcs = row.pcs ?? [];
      if (!pcs.length) continue;
      const midis = pcs.map((pc, i) => 48 + pc + (i > 0 ? 12 * Math.min(2, i) : 0));
      for (const m of midis) {
        harmonyEvents.push({ beat: row.start, bytes: [0x91, m, 64] });
        harmonyEvents.push({ beat: row.start + (row.dur ?? beatsPerBar) * 0.98, bytes: [0x81, m, 0] });
      }
    }
  }
  const harmonyTrack = track(harmonyEvents, 'Harmony');

  const tracks = [tempoTrack, melodyTrack, harmonyTrack];
  if (options.includeMotif && options.motif) {
    const motifEvents = [];
    for (const e of options.motif.events) {
      motifEvents.push({ beat: e.start, bytes: [0x92, e.pitch, 80] });
      motifEvents.push({ beat: e.start + e.dur * 0.98, bytes: [0x82, e.pitch, 0] });
    }
    tracks.push(track(motifEvents, `Motif: ${options.motif.name ?? 'motif'}`));
  }
  // Patch the header track count to match what we emitted.
  chunk[10] = 0;
  chunk[11] = tracks.length;

  for (const t of tracks) {
    chunk.push(...str('MTrk'), ...u32(t.length), ...t);
  }
  return new Uint8Array(chunk);
}

/** Lightweight parser used by tests to confirm what was written. */
export function parseMidi(bytes) {
  let i = 0;
  const readStr = (n) => {
    let s = '';
    for (let k = 0; k < n; k += 1) s += String.fromCharCode(bytes[i + k]);
    i += n;
    return s;
  };
  const readU32 = () => {
    const v = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    i += 4;
    return v >>> 0;
  };
  const readU16 = () => {
    const v = (bytes[i] << 8) | bytes[i + 1];
    i += 2;
    return v;
  };
  if (readStr(4) !== 'MThd') throw new Error('not a MIDI file');
  const headerLen = readU32();
  const format = readU16();
  const trackCount = readU16();
  const division = readU16();
  i += headerLen - 6;
  const tracks = [];
  for (let t = 0; t < trackCount; t += 1) {
    if (readStr(4) !== 'MTrk') throw new Error(`expected MTrk at track ${t}`);
    const len = readU32();
    const end = i + len;
    let tick = 0;
    let running = 0;
    const events = [];
    while (i < end) {
      let delta = 0;
      let byte;
      do {
        byte = bytes[i];
        i += 1;
        delta = (delta << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      tick += delta;
      if (i >= end) break;
      let status = bytes[i];
      if (status & 0x80) {
        i += 1;
        running = status;
      } else if (running) {
        status = running;
      } else {
        throw new Error(`Missing status byte at offset ${i}`);
      }
      if (status === 0xff) {
        const type = bytes[i];
        i += 1;
        let len2 = 0;
        let b;
        do {
          b = bytes[i];
          i += 1;
          len2 = (len2 << 7) | (b & 0x7f);
        } while (b & 0x80);
        const data = bytes.slice(i, i + len2);
        i += len2;
        events.push({ tick, meta: type, data: [...data] });
      } else {
        const kind = status & 0xf0;
        const channel = status & 0x0f;
        const n = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        const data = bytes.slice(i, i + n);
        i += n;
        events.push({ tick, status, kind, channel, data: [...data] });
      }
    }
    tracks.push(events);
  }
  return { format, trackCount, division, tracks };
}

export function downloadMidi(bytes, filename = 'phrase.mid') {
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

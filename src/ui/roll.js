// SVG piano-roll rendering. Rects are the actual phrase events: x = beat,
// y = pitch. Slot boundaries and the harmony row are drawn from the same data.

import { midiToPitch, pcName } from '../music/pitch.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/*
 * slotColors carries one colour per phrase template slot so the same segment
 * is the same colour in every view.
 */
export const SLOT_COLORS = ['#6ea8fe', '#c792ea', '#f0b46b', '#8be0c0'];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @param {object} opts
 * @param {object[]} opts.events [{ pitch, start, dur, role?, sourceIndex?, noteType? }]
 * @param {number} opts.totalBeats
 * @param {number} opts.beatsPerBar
 * @param {object[]} opts.harmonyRows
 * @param {string[]} opts.slotColors per-event colors, or use event.color
 * @param {object[]} opts.segments optional [{ start, end, role, label, color }]
 * @param {number} opts.low/high pitch range override
 * @param {boolean} opts.compact
 * @param {object[]} opts.regions optional highlighted [start,end] ranges
 */
export function renderRoll(container, opts) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) return;
  const events = opts.events ?? [];
  if (!events.length) {
    host.innerHTML = '<div class="hint">暂无音符</div>';
    return;
  }
  const lowOpt = opts.low ?? Math.min(...events.map((e) => e.pitch));
  const highOpt = opts.high ?? Math.max(...events.map((e) => e.pitch));
  const pad = 2;
  const low = Math.floor(lowOpt / 12) * 12 - (opts.padOctaves ? 0 : 0) - pad;
  const high = Math.ceil((highOpt + 1) / 12) * 12 + pad;
  const totalBeats = opts.totalBeats ?? Math.max(...events.map((e) => e.start + e.dur));
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const compact = opts.compact ?? false;

  const keyboardW = compact ? 26 : 42;
  const gutterTop = compact ? 4 : 20;
  const boilerH = compact ? 0 : 30;
  const barH = compact ? 11 : Math.max(14, Math.min(26, 420 / Math.max(1, high - low)));
  const beatW = compact ? 17 : 30;
  const width = keyboardW + totalBeats * beatW + (compact ? 2 : 18);
  const height = gutterTop + (high - low) * barH + boilerH + 6;

  const x = (beat) => keyboardW + beat * beatW;
  const y = (pitch) => gutterTop + (high - pitch) * barH;

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="钢琴卷帘谱">`);

  // Background bands per scale-ish bar.
  const barCount = Math.ceil(totalBeats / beatsPerBar);
  for (let b = 0; b < barCount; b += 1) {
    if (b % 2 === 0) {
      parts.push(`<rect x="${x(b * beatsPerBar)}" y="${gutterTop}" width="${beatsPerBar * beatW}" height="${(high - low) * barH}" fill="#141922"/>`);
    }
  }
  // Black-key rows.
  for (let p = low; p <= high; p += 1) {
    const name = NOTE_NAMES[((p % 12) + 12) % 12];
    if (name.includes('#')) {
      parts.push(`<rect x="${keyboardW}" y="${y(p)}" width="${totalBeats * beatW}" height="${barH}" fill="#11151d"/>`);
    }
  }
  // Bar/beat gridlines.
  for (let b = 0; b <= totalBeats; b += 1) {
    const isBar = Math.abs(b % beatsPerBar) < 1e-9;
    const isBeat = Math.abs(b - Math.round(b)) < 1e-9;
    if (!isBeat) continue;
    parts.push(`<line x1="${x(b)}" y1="${gutterTop}" x2="${x(b)}" y2="${gutterTop + (high - low) * barH}" stroke="${isBar ? '#2a3344' : '#1b2130'}" stroke-width="${isBar ? 1.2 : 0.7}"/>`);
  }
  // Octave labels on keyboard side.
  if (!compact) {
    for (let p = low; p <= high; p += 1) {
      if (p % 12 === 0) {
        parts.push(`<text x="${keyboardW - 6}" y="${y(p) + barH * 0.72}" fill="#55627a" font-size="9" text-anchor="end">${midiToPitch(p)}</text>`);
      }
    }
  }
  // Slot regions.
  for (const seg of opts.segments ?? []) {
    const color = seg.color ?? '#6ea8fe';
    parts.push(`<rect x="${x(seg.start)}" y="${gutterTop}" width="${Math.max(0.5, (seg.end - seg.start) * beatW)}" height="${(high - low) * barH}" fill="${color}" opacity="0.055"/>`);
    if (!compact && seg.label) {
      parts.push(`<text x="${x(seg.start) + 4}" y="${gutterTop + 12}" fill="${color}" font-size="10" opacity="0.9">${esc(seg.label)}</text>`);
      parts.push(`<line x1="${x(seg.start)}" y1="${gutterTop}" x2="${x(seg.start)}" y2="${gutterTop + (high - low) * barH}" stroke="${color}" stroke-opacity="0.4" stroke-dasharray="3 3"/>`);
    }
  }

  // Notes.
  for (const e of events) {
    const color = e.color ?? colorForRole(e.role, opts);
    const nx = x(e.start);
    const nw = Math.max(3, e.dur * beatW - 1.5);
    const ny = y(e.pitch) + 0.5;
    const nh = Math.max(3, barH - 1);
    const isNct = e.noteType === 'passing' || e.noteType === 'auxiliary';
    const stroke = isNct ? '#f0b46b' : 'rgba(0,0,0,0.35)';
    parts.push(
      `<rect x="${nx.toFixed(2)}" y="${ny.toFixed(2)}" width="${nw.toFixed(2)}" height="${nh.toFixed(2)}" rx="2" fill="${color}" stroke="${stroke}" stroke-width="${isNct ? 1.3 : 0.6}" opacity="${e.dim ? 0.35 : 0.95}">` +
        `<title>${esc(midiToPitch(e.pitch))} · beat ${round(e.start)} · ${round(e.dur)} beat${e.dur === 1 ? '' : 's'}${e.chord ? ` · ${esc(e.chord)}` : ''}${e.noteType ? ` · ${e.noteType}` : ''}</title>` +
      '</rect>',
    );
    if (!compact && nw > 26) {
      parts.push(`<text x="${(nx + 3).toFixed(2)}" y="${(ny + nh * 0.72).toFixed(2)}" fill="rgba(8,12,20,0.85)" font-size="${Math.min(9, nh * 0.6).toFixed(1)}">${esc(midiToPitch(e.pitch))}</text>`);
    }
  }

  // Harmony strip along the bottom.
  if (!compact && opts.harmonyRows?.length) {
    const hy = gutterTop + (high - low) * barH + 4;
    for (const row of opts.harmonyRows) {
      const rx = x(row.start);
      const rw = (row.dur ?? beatsPerBar) * beatW;
      parts.push(`<rect x="${rx}" y="${hy}" width="${rw - 1}" height="${boilerH - 8}" rx="3" fill="#1b2230" stroke="#273043"/>`);
      parts.push(`<text x="${rx + 5}" y="${hy + 14}" fill="#9fb0c8" font-size="10">${esc(row.symbol ?? '—')}</text>`);
    }
  }

  if (opts.cursorBeat != null) {
    parts.push(`<line class="play-cursor" x1="${x(opts.cursorBeat)}" y1="${gutterTop}" x2="${x(opts.cursorBeat)}" y2="${gutterTop + (high - low) * barH}" />`);
  }

  parts.push('</svg>');
  host.innerHTML = parts.join('');
  return { width, height, x, y, beatW, barH, low, high };
}

export function colorForRole(role, opts) {
  const idx = (opts?.roleOrder ?? ['A', "A′", 'B', 'A″', 'C', 'A″', 'a', "a′", 'b', 'cad']).indexOf(role);
  if (idx >= 0) return SLOT_COLORS[idx % SLOT_COLORS.length];
  return opts?.defaultColor ?? '#6ea8fe';
}

export function round(v) {
  return Math.round(v * 100) / 100;
}

/** Colours assigned by slot position, used consistently across every view. */
export function slotColorMap(templateSlots) {
  const map = new Map();
  templateSlots.forEach((slot, i) => map.set(slot.role, SLOT_COLORS[i % SLOT_COLORS.length]));
  return map;
}

export function annotateEvents(candidate, colorMap) {
  return candidate.events.map((e) => {
    const seg = candidate.segments.find((s) => e.start >= s.slotStart - 1e-9 && e.start < s.slotStart + s.slotBudget - 1e-9);
    const cls = seg?.classification?.find((n) => Math.abs(n.start - e.start) < 1e-9 && n.pitch === e.pitch);
    return {
      ...e,
      role: seg?.role,
      color: seg ? colorMap.get(seg.role) : '#6ea8fe',
      noteType: cls?.type,
      chord: cls?.chord,
    };
  });
}

export function noteName(pc) {
  return pcName(pc);
}

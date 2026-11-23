import { describe, it, expect } from 'vitest';
import { generatePhrases, parseMotifText } from '../src/music/generator.js';
import { phraseToMidi, parseMidi } from '../src/audio/midi.js';

const motif = () => parseMotifText('C4:1 D4:0.5 E4:0.5 G4:1 E4:0.5 C4:0.5 D4:1', { name: 'MIDI test' });

describe('MIDI export', () => {
  it('writes a valid format-1 file whose notes match the phrase exactly', () => {
    const result = generatePhrases(motif(), { seed: 'midi', tempo: 120 });
    const phrase = result.chosen;
    const bytes = phraseToMidi(phrase, {
      tempo: 120,
      beatsPerBar: 4,
      includeHarmony: true,
      includeMotif: true,
      motif: result.motif,
    });
    const parsed = parseMidi(bytes);
    expect(parsed.format).toBe(1);
    expect(parsed.division).toBe(480);
    expect(parsed.trackCount).toBe(4);

    // Melody track is track index 1.
    const melody = parsed.tracks[1];
    const noteOns = melody.filter((e) => e.kind === 0x90);
    const noteOffs = melody.filter((e) => e.kind === 0x80);
    expect(noteOns).toHaveLength(phrase.events.length);
    expect(noteOffs).toHaveLength(phrase.events.length);
    const onsets = noteOns.map((e) => e.tick / 480);
    const expected = phrase.events.map((e) => e.start);
    expect(onsets).toEqual(expected);
    expect(noteOns.map((e) => e.data[0])).toEqual(phrase.events.map((e) => e.pitch));
  });

  it('encodes the tempo exactly', () => {
    const result = generatePhrases(motif(), { seed: 'tempo', tempo: 132 });
    const bytes = phraseToMidi(result.chosen, { tempo: 132 });
    const parsed = parseMidi(bytes);
    const tempoMeta = parsed.tracks[0].find((e) => e.meta === 0x51);
    const us = (tempoMeta.data[0] << 16) | (tempoMeta.data[1] << 8) | tempoMeta.data[2];
    expect(Math.round(60000000 / us)).toBe(132);
  });

  it('includes harmony notes on channel 2 and the motif on channel 3', () => {
    const result = generatePhrases(motif(), { seed: 'channels' });
    const bytes = phraseToMidi(result.chosen, { includeHarmony: true, includeMotif: true, motif: result.motif });
    const parsed = parseMidi(bytes);
    const harmonyOns = parsed.tracks[2].filter((e) => e.kind === 0x90);
    const motifOns = parsed.tracks[3].filter((e) => e.kind === 0x90);
    expect(harmonyOns.length).toBeGreaterThan(0);
    expect(harmonyOns.every((e) => e.channel === 1)).toBe(true);
    expect(motifOns.map((e) => e.data[0])).toEqual(result.motif.events.map((e) => e.pitch));
    expect(motifOns.every((e) => e.channel === 2)).toBe(true);
  });

  it('is byte-for-byte deterministic', () => {
    const a = generatePhrases(motif(), { seed: 'bytes' });
    const b = generatePhrases(motif(), { seed: 'bytes' });
    const ba = phraseToMidi(a.chosen, { includeHarmony: true });
    const bb = phraseToMidi(b.chosen, { includeHarmony: true });
    expect(Buffer.from(ba).equals(Buffer.from(bb))).toBe(true);
  });
});

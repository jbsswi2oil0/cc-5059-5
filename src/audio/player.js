// Web Audio playback of a generated phrase, with optional metronome and a
// simple string/pad timbre. Audio events are derived from the same note events
// the phrase displays, so what you hear is what is scored.

export class PhrasePlayer {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sources = [];
    this.timers = [];
    this.state = 'idle';
    this.onstatechange = null;
  }

  _ensureContext() {
    if (!this.ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio API is not available in this browser');
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  _setState(state) {
    this.state = state;
    this.onstatechange?.(state);
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* noop */
      }
    }
    this.sources = [];
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    this._setState('idle');
  }

  /**
   * @param {object} phrase generated candidate (needs events, harmony)
   * @param {object} options { tempo, beatsPerBar, metronome, melody, accompaniment }
   */
  async play(phrase, options = {}) {
    this.stop();
    const ctx = this._ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const tempo = options.tempo ?? 96;
    const beatsPerBar = options.beatsPerBar ?? 4;
    const secPerBeat = 60 / tempo;
    const start = ctx.currentTime + 0.08;
    const endBeat = phrase.totalBeats;

    const melodyGain = ctx.createGain();
    melodyGain.gain.value = 0.5;
    melodyGain.connect(this.master);

    const eventBeats = phrase.events.map((e) => e.start);
    const timerIds = [];

    for (const ev of phrase.events) {
      const t0 = start + ev.start * secPerBeat;
      const lead = (t0 - ctx.currentTime) * 1000;
      const timer = setTimeout(() => this._pluck(ctx, melodyGain, ev.pitch, t0, ev.dur * secPerBeat * 0.96, 0.5), Math.max(0, lead));
      timerIds.push(timer);
      this.timers.push(timer);
    }

    if (options.accompaniment) {
      const padGain = ctx.createGain();
      padGain.gain.value = 0.16;
      padGain.connect(this.master);
      for (const row of phrase.harmony) {
        const t0 = start + row.start * secPerBeat;
        const lead = (t0 - ctx.currentTime) * 1000;
        const dur = (row.dur ?? beatsPerBar) * secPerBeat;
        const timer = setTimeout(() => this._pad(ctx, padGain, row, t0, dur), Math.max(0, lead));
        timerIds.push(timer);
        this.timers.push(timer);
      }
    }

    if (options.metronome) {
      const clickGain = ctx.createGain();
      clickGain.gain.value = 0.13;
      clickGain.connect(this.master);
      for (let b = 0; b <= endBeat; b += 1) {
        const t0 = start + b * secPerBeat;
        const lead = (t0 - ctx.currentTime) * 1000;
        const timer = setTimeout(() => this._click(ctx, clickGain, t0, b % beatsPerBar === 0), Math.max(0, lead));
        timerIds.push(timer);
        this.timers.push(timer);
      }
    }

    this._setState('playing');
    const totalMs = (start - ctx.currentTime + endBeat * secPerBeat + 0.4) * 1000;
    const done = setTimeout(() => {
      if (this.state === 'playing') this._setState('idle');
    }, totalMs);
    this.timers.push(done);
    this.lastSchedule = {
      tempo,
      secPerBeat,
      notes: phrase.events.length,
      beats: endBeat,
      eventBeats,
      scheduledAt: start,
      totalMs: Math.round(totalMs),
    };
    return this.lastSchedule;
  }

  _pluck(ctx, dest, midi, when, dur, level) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc2.type = 'sine';
    osc.frequency.value = freq;
    osc2.frequency.value = freq * 2.002;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(8000, freq * 8), when);
    filter.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2), when + Math.max(0.06, dur));
    const peak = level * 0.5;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.012);
    gain.gain.exponentialRampToValueAtTime(peak * 0.55, when + Math.max(0.05, dur * 0.5));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.06);
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(when);
    osc2.start(when);
    osc.stop(when + dur + 0.08);
    osc2.stop(when + dur + 0.08);
    this.sources.push(osc, osc2);
    osc.onended = () => {
      gain.disconnect();
      filter.disconnect();
    };
  }

  _pad(ctx, dest, row, when, dur) {
    const pcs = row.pcs?.length ? row.pcs : [];
    const notes = pcs.map((pc, i) => 48 + pc + (i === 0 ? 0 : 12 * (i > 2 ? 2 : 1)));
    for (const midi of notes) {
      const freq = 440 * 2 ** ((midi - 69) / 12);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.value = freq;
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.6, when + 0.08);
      gain.gain.setValueAtTime(0.6, when + Math.max(0.1, dur * 0.7));
      gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      osc.start(when);
      osc.stop(when + dur + 0.02);
      this.sources.push(osc);
    }
  }

  _click(ctx, dest, when, accented) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accented ? 1600 : 1050;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(accented ? 1 : 0.55, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(when);
    osc.stop(when + 0.06);
    this.sources.push(osc);
  }
}

// Motif development workbench controller.
// Every control calls the TransformSession kernel; the UI never computes
// pitches itself. Failed transforms are reported back and the previous
// listenable version stays on screen and playable.

import { TransformSession } from '../music/session.js';
import { parsePitch, midiToPitch } from '../music/pitch.js';
import { renderRoll } from './roll.js';
import { describeOp } from '../music/ops.js';

const $ = (id) => document.getElementById(id);

export class SessionWorkbench {
  constructor({ player, readMotif, readRegister, onError }) {
    this.player = player;
    this.readMotif = readMotif;
    this.readRegister = readRegister;
    this.onError = onError ?? (() => {});
    this.session = null;
    this.lastMotifKey = null;
  }

  boot() {
    this._wire();
    this.resetFromMotif();
  }

  /** Rebuild the session from the motif textarea contents. */
  resetFromMotif() {
    const motif = this.readMotif();
    const key = JSON.stringify(motif.events.map((e) => [e.pitch, e.start, e.dur]));
    if (key === this.lastMotifKey && this.session) return;
    this.lastMotifKey = key;
    const { low, high } = this.readRegister();
    this.session = new TransformSession(motif.events, {
      register: { low, high },
      maxDuration: Number($('ss-maxdur').value) || 16,
      ending: this._readEnding(),
    });
    this.render();
  }

  _readEnding() {
    const text = $('ss-ending').value.trim();
    return text ? { exactMidi: parsePitch(text) } : null;
  }

  _wire() {
    $('ss-apply-transpose').addEventListener('click', () => {
      const semitones = Number($('ss-transpose').value) || 0;
      this._submit({ op: 'transpose', params: { semitones } });
    });
    $('ss-apply-rhythm').addEventListener('click', () => {
      const factor = Number($('ss-rhythm').value) || 1;
      this._submit({ op: 'rhythm', params: { factor } });
    });
    $('ss-apply-invert').addEventListener('click', () => {
      const axis = Number($('ss-axis').value) || 60;
      this._submit({ op: 'invert', params: { axis } });
    });
    $('ss-apply-retro').addEventListener('click', () => {
      this._submit({ op: 'retrograde' });
    });
    $('session-undo').addEventListener('click', () => {
      const restored = this.session.undo();
      if (restored) this._feedback('ok', '已撤销上一步，恢复到上一个可试听版本。');
      this.render();
    });
    $('session-reset').addEventListener('click', () => {
      this.lastMotifKey = null;
      this.resetFromMotif();
      this._feedback('ok', '已重置到原始主题。');
    });
    $('session-play').addEventListener('click', () => this._play());
    $('ss-rekey').addEventListener('click', () => this._rekey());
    $('ss-ending').addEventListener('change', () => this._rekey());
    $('ss-maxdur').addEventListener('change', () => this._rekey());
  }

  _submit(op) {
    const result = this.session.apply(op);
    if (result.ok) {
      this._feedback('ok', `变换「${describeOp(op)}」已提交，共 ${this.session.committedOps().length} 步已入日志。`);
    } else {
      const rejected = result.intermediate.map((e) => midiToPitch(e.pitch)).join(' ');
      const reasons = result.violations.join(' / ') || result.message || '未知约束';
      this._feedback('bad', `变换「${describeOp(op)}」被回滚（违反：${reasons}），保留上一可试听版本。`, rejected);
    }
    this.render();
    return result;
  }

  _rekey() {
    let ending = null;
    try {
      ending = this._readEnding();
    } catch (err) {
      this._feedback('bad', `结尾音名无效：${err.message}`);
      return;
    }
    const { low, high } = this.readRegister();
    const result = this.session.rekey({
      register: { low, high },
      maxDuration: Number($('ss-maxdur').value) || 16,
      ending,
    });
    const anchor = ending ? `结尾锚 ${midiToPitch(ending.exactMidi)}` : '无结尾锚';
    if (result.ok) {
      this._feedback('ok', `约束已按当前音域 ${midiToPitch(low)}–${midiToPitch(high)} 与 ${anchor} 重建，未沿用旧锚。`);
    } else {
      this._feedback('bad', `约束已重建（${anchor}），但当前版本违反：${result.violations.join(' / ')}；事件未被删除，可撤销。`);
    }
    this.render();
  }

  async _play() {
    const events = this.session.current();
    try {
      await this.player.play(
        {
          events,
          totalBeats: Math.max(...events.map((e) => e.start + e.dur)),
          harmony: [],
        },
        { tempo: Number($('tempo').value) || 96, beatsPerBar: 4, metronome: $('metronome').checked },
      );
    } catch (err) {
      this.onError(`试听失败：${err.message}`);
    }
  }

  _feedback(kind, message, rejectedPitches = null) {
    const host = $('session-feedback');
    host.hidden = false;
    host.className = `session-feedback ${kind}`;
    host.innerHTML = `${escapeHtml(message)}${rejectedPitches ? `<div class="rejected">被拒中间结果：${escapeHtml(rejectedPitches)}</div>` : ''}`;
  }

  render() {
    const events = this.session.current();
    const { low, high } = this.readRegister();
    renderRoll($('session-roll'), {
      events: events.map((e) => ({ ...e, role: 'motif', color: '#8be0c0' })),
      totalBeats: Math.max(...events.map((e) => e.start + e.dur)),
      beatsPerBar: 4,
      low: Math.min(low, ...events.map((e) => e.pitch)) - 2,
      high: Math.max(high, ...events.map((e) => e.pitch)) + 2,
    });
    const dur = Math.max(...events.map((e) => e.start + e.dur));
    $('session-meta').textContent =
      `${events.length} 个音 · ${Math.round(dur * 100) / 100} 拍 · ${events.map((e) => midiToPitch(e.pitch)).join(' ')}`;
    $('session-count').textContent =
      `已提交 ${this.session.committedOps().length} 步 · 回滚 ${this.session.failures().length} 次`;

    const rows = this.session.log
      .filter((entry) => entry.op)
      .map((entry) => {
        const state = entry.reversed ? '已回滚' : '已提交';
        const detail = entry.reversed ? `违反 ${entry.violations.join('/')}` : describeOp(entry.op);
        return `<div class="log-row ${entry.reversed ? 'reversed' : 'committed'}">
          <span class="tag-op">${escapeHtml(describeOp(entry.op))}</span>
          <span>${escapeHtml(detail)}</span>
          <span class="tag-state">${state}</span>
        </div>`;
      })
      .join('');
    $('session-log').innerHTML = rows || '<div class="hint">尚无变换，主题为初始可试听版本。</div>';
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

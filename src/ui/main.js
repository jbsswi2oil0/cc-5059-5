import {
  generatePhrases,
  parseMotifText,
  resolveOptions,
  PHRASE_TEMPLATES,
  DEFAULT_OPTIONS,
  ENGINE_VERSION,
} from '../music/generator.js';
import { midiToPitch, pcName, parsePitch, SCALES } from '../music/pitch.js';
import { PhrasePlayer } from '../audio/player.js';
import { phraseToMidi, downloadMidi } from '../audio/midi.js';
import { renderRoll, annotateEvents, slotColorMap, SLOT_COLORS, round } from './roll.js';
import { SessionWorkbench } from './session.js';

const $ = (id) => document.getElementById(id);
const player = new PhrasePlayer();

const state = {
  result: null,
  chosenIndex: 0,
  colorMap: new Map(),
  currentMotifName: '初稿动机',
  motifText: 'C4:1 D4:0.5 E4:0.5 G4:1 E4:0.5 C4:0.5 D4:1',
};

let workbench = null;

const PRESETS = [
  { name: '上行琶音', text: 'C4:1 E4:1 G4:1 A4:1' },
  { name: '问答动机', text: 'C4:0.5 D4:0.5 E4:1 G4:0.5 E4:0.5 C4:1' },
  { name: '级进叹息', text: 'G4:1 F4:0.5 E4:0.5 D4:1 C4:2' },
  { name: '跳跃动机', text: 'C4:0.5 G4:1 E4:0.5 A4:1 G4:1' },
];

// ---------------------------------------------------------------------------
// Bootstrap controls
// ---------------------------------------------------------------------------

function fillSelects() {
  const tonic = $('tonic');
  const pcs = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  tonic.innerHTML = pcs.map((pc, i) => `<option value="${pc}">${pc} / ${flats[i]}</option>`).join('');
  tonic.value = 'C';

  const mode = $('mode');
  mode.innerHTML = Object.keys(SCALES)
    .map((m) => `<option value="${m}">${m}</option>`)
    .join('');
  mode.value = 'major';

  const endingPc = $('ending-pc');
  endingPc.innerHTML = pcs.map((pc, i) => `<option value="${pc}">${pc} / ${flats[i]}</option>`).join('');
  endingPc.value = 'C';

  const template = $('template');
  template.innerHTML = Object.entries(PHRASE_TEMPLATES)
    .map(([id, t]) => `<option value="${id}">${t.name} — ${t.description}</option>`)
    .join('');
  template.value = DEFAULT_OPTIONS.template;

  const presetRow = $('preset-row');
  presetRow.innerHTML = PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${p.name}</button>`).join('');
  presetRow.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-preset]');
    if (!btn) return;
    const preset = PRESETS[Number(btn.dataset.preset)];
    $('motif-text').value = preset.text;
    $('motif-name').value = preset.name;
    updateMotifHint();
  });

  $('engine-badge').textContent = `engine v${ENGINE_VERSION} · deterministic`;
}

function readOptions() {
  const numbers = (text) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  const endingMode = $('ending-mode').value;
  return {
    key: { tonic: $('tonic').value, mode: $('mode').value },
    register: { lowNote: $('reg-low').value.trim(), highNote: $('reg-high').value.trim() },
    harmony: $('harmony').value.split(',').map((s) => s.trim()).filter(Boolean),
    ending: {
      pc: $('ending-pc').value,
      lowNote: $('ending-low').value.trim(),
      highNote: $('ending-high').value.trim(),
      exactMidi: endingMode === 'exact' ? parsePitch($('ending-low').value.trim()) : null,
    },
    template: $('template').value,
    tempo: Number($('tempo').value) || 96,
    candidateCount: Math.max(1, Math.min(12, Number($('candidate-count').value) || 6)),
    seed: $('seed').value.trim() || 'theme-1',
    allow: {
      inversion: $('allow-invert').checked,
      retrograde: $('allow-retro').checked,
      rhythm: $('allow-rhythm').checked,
      diatonicTranspose: $('allow-transpose').checked,
    },
    rhythmFactors: numbers($('rhythm-factors').value).filter((n) => n > 0),
  };
}

// ---------------------------------------------------------------------------
// Motif parsing + hint
// ---------------------------------------------------------------------------

function readMotif() {
  return parseMotifText($('motif-text').value, {
    id: 'motif-1',
    name: $('motif-name').value.trim() || 'Motif',
  });
}

function updateMotifHint() {
  const hint = $('motif-hint');
  try {
    const motif = readMotif();
    const dur = motif.events.reduce((m, e) => Math.max(m, e.start + e.dur), 0);
    const notes = motif.events.map((e) => midiToPitch(e.pitch)).join(' ');
    hint.textContent = `${motif.events.length} 个音，${round(dur)} 拍：${notes}`;
    hint.classList.remove('bad');
    return motif;
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add('bad');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generate + render
// ---------------------------------------------------------------------------

let lastRequested = null;

function generate() {
  const banner = $('error-banner');
  banner.hidden = true;
  let motif;
  try {
    motif = readMotif();
  } catch (err) {
    showError([`动机解析失败：${err.message}`]);
    return;
  }
  let options;
  try {
    options = readOptions();
  } catch (err) {
    showError([`参数错误：${err.message}`]);
    return;
  }
  let result;
  try {
    lastRequested = { motif, options };
    result = generatePhrases(motif, options);
  } catch (err) {
    showError([`生成失败：${err.message}`]);
    return;
  }
  state.result = result;
  state.chosenIndex = 0;
  state.currentMotifName = motif.name;
  state.motifText = $('motif-text').value;
  state.colorMap = slotColorMap(result.template?.slots ?? []);
  workbench?.resetFromMotif();
  renderMotif();
  renderLegend();
  if (!result.ok) {
    renderFailure(result);
    $('candidates').innerHTML = '';
    $('detail-panel').hidden = true;
    return;
  }
  $('error-banner').hidden = true;
  renderCandidates();
  selectCandidate(0);
}

function showError(lines) {
  const banner = $('error-banner');
  banner.hidden = false;
  banner.innerHTML = `<h3>无法生成</h3><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
}

function renderFailure(result) {
  const diag = result.diagnostics;
  const lines = [...(diag.reasons ?? [])];
  if (diag.motifHarmonyWarning) lines.push(diag.motifHarmonyWarning);
  if (result.reason) lines.push(`(reason code: ${result.reason})`);
  showError(lines);
  const extra = [];
  if (diag.log?.length) extra.push(`生成日志（已去重）：\n${diag.log.join('\n')}`);
  const issues = (diag.slotIssues ?? []).map((s) => `${s.slot}: generated ${s.total}, used ${s.used}, inversion repairs ${s.inversionRepairs ?? 0}`);
  if (issues.length) extra.push(`分句槽位：\n${issues.join('\n')}`);
  $('motif-meta').textContent = '';
  const banner = $('error-banner');
  if (extra.length) {
    banner.innerHTML += `<details style="margin-top:8px"><summary style="cursor:pointer;color:inherit">技术细节</summary><pre style="white-space:pre-wrap;font-size:11px;margin:8px 0 0">${escapeHtml(extra.join('\n\n'))}</pre></details>`;
  }
}

function renderMotif() {
  const motif = state.result.motif;
  const low = parsePitch($('reg-low').value);
  const high = parsePitch($('reg-high').value);
  renderRoll($('motif-roll'), {
    events: motif.events.map((e) => ({ ...e, role: 'motif', color: '#6ea8fe' })),
    totalBeats: Math.max(...motif.events.map((e) => e.start + e.dur)),
    beatsPerBar: 4,
    low: Math.min(low, ...motif.events.map((e) => e.pitch)) - 2,
    high: Math.max(high, ...motif.events.map((e) => e.pitch)) + 2,
  });
  $('motif-meta').textContent = `${motif.name} · ${motif.events.length} notes · ${round(Math.max(...motif.events.map((e) => e.start + e.dur)))} beats · register ${midiToPitch(low)}–${midiToPitch(high)}`;
}

function renderLegend() {
  const slots = state.result?.template?.slots ?? [];
  $('legend').innerHTML = slots
    .map((s) => `<span><i class="segment-swatch" style="background:${state.colorMap.get(s.role)}"></i>${escapeHtml(s.role)} · ${escapeHtml(s.label)}</span>`)
    .join('');
}

function renderCandidates() {
  const { result } = state;
  const host = $('candidates');
  host.innerHTML = '';
  result.candidates.forEach((cand, idx) => {
    const el = document.createElement('article');
    el.className = 'candidate';
    el.dataset.index = String(idx);
    const annotated = annotateEvents(cand, state.colorMap);
    const chips = cand.constraints.checks
      .map((c) => `<span class="chip ${c.ok ? 'ok' : 'fail'}">${c.ok ? '✓' : '✕'} ${escapeHtml(c.label)}</span>`)
      .join('');
    el.innerHTML = `
      <div class="candidate-head">
        <div class="candidate-title"><span class="rank">${cand.rank}</span>候选 ${cand.rank}</div>
        <div class="score">风格分 <b>${(cand.style.total * 100).toFixed(1)}</b> / 100 · ${round(cand.totalBeats)} 拍</div>
      </div>
      <div class="mini-roll"></div>
      <div class="chips">${chips}</div>
    `;
    renderRoll(el.querySelector('.mini-roll'), {
      events: annotated,
      totalBeats: cand.totalBeats,
      beatsPerBar: 4,
      low: parsePitch($('reg-low').value) - 2,
      high: parsePitch($('reg-high').value) + 2,
      compact: true,
      segments: cand.segments.map((s) => ({
        start: s.slotStart,
        end: s.slotStart + s.slotBudget,
        color: state.colorMap.get(s.role),
      })),
      roleOrder: result.template.slots.map((s) => s.role),
    });
    el.addEventListener('click', () => selectCandidate(idx));
    host.appendChild(el);
  });
}

function selectCandidate(index) {
  if (!state.result?.ok) return;
  state.chosenIndex = index;
  const cand = state.result.candidates[index];
  document.querySelectorAll('.candidate').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.index) === index);
  });
  renderDetail(cand);
}

function renderDetail(cand) {
  $('detail-panel').hidden = false;
  const body = $('detail-body');
  const { result } = state;
  const beatsPerBar = 4;
  const annotated = annotateEvents(cand, state.colorMap);

  const checks = cand.constraints.checks
    .map(
      (c) => `
      <div class="check-item">
        <span class="check-icon ${c.ok ? 'ok' : 'fail'}">${c.ok ? '✓' : '✕'}</span>
        <div>
          <div class="check-label">${escapeHtml(c.label)} ${c.ok ? '' : '— 失败'}</div>
          <div class="check-detail">${escapeHtml(c.detail)}</div>
        </div>
      </div>`,
    )
    .join('');

  const segRows = cand.segments
    .map((seg, i) => {
      const color = state.colorMap.get(seg.role);
      const pitches = seg.events.map((e) => midiToPitch(e.pitch)).join(' ');
      const range = seg.sourceNoteRange;
      const ops = seg.opSummary.length
        ? seg.opSummary.map((o) => `<span class="op">${escapeHtml(o.label)}</span>`).join('')
        : '<span class="op">literal restatement (no transform)</span>';
      const v = seg.verification;
      const notesDetail = seg.classification
        .map((n) => {
          const cls = n.type === 'chord' ? 'chord' : n.type;
          return `<span class="tag ${cls}" title="${escapeHtml(n.reason ?? '')}">${escapeHtml(n.note)} ${n.type}${n.chord ? `/${escapeHtml(n.chord)}` : ''}</span>`;
        })
        .join('');
      return `
        <tr data-seg="${i}">
          <td><span class="segment-swatch" style="background:${color}"></span><b>${escapeHtml(seg.role)}</b><div class="check-detail">${escapeHtml(seg.label)}</div></td>
          <td class="mono">${round(seg.slotStart)}–${round(seg.slotStart + seg.slotBudget)}<div class="check-detail">${midiToPitch(seg.events[0].pitch)} … ${midiToPitch(seg.events.at(-1).pitch)}</div></td>
          <td class="mono">${escapeHtml(rangeLabel(range, result.motif.events.length))}<div class="check-detail">${escapeHtml(pitches)}</div></td>
          <td><div class="ops">${ops}</div><div class="check-detail" style="margin-top:5px">contour ${(seg.contour.score * 100).toFixed(0)}%</div></td>
          <td class="verification ${v.ok ? 'ok' : 'fail'}">${v.ok ? '✓ replay matches motif ops' : escapeHtml(v.errors.join('\n'))}</td>
        </tr>
        <tr data-seg-notes="${i}">
          <td colspan="5"><div class="note-detail">${notesDetail}</div></td>
        </tr>`;
    })
    .join('');

  const comps = cand.style.components
    .map(
      (c) => `
      <div class="comp">
        <div class="comp-label"><span>${escapeHtml(c.label)}</span><span>${(c.value * 100).toFixed(0)} × ${c.weight}</span></div>
        <div class="bar"><i style="width:${(c.value * 100).toFixed(1)}%"></i></div>
        <div class="comp-detail">${escapeHtml(c.detail)}</div>
      </div>`,
    )
    .join('');

  const repro = cand.reproducibility;
  const repairDetails = renderRepairDetails(result, cand);

  body.innerHTML = `
    <div class="detail-grid">
      <div class="roll" id="detail-roll"></div>
      <div>
        <div class="subhead"><span>分句结构（每段来自哪个动机片段、用了哪些操作）</span><span>模板：${escapeHtml(result.template.name)}</span></div>
        <table class="segment-table">
          <thead><tr><th>段落</th><th>小节范围</th><th>动机来源 → 实际音高</th><th>操作链与轮廓</th><th>谱系核对</th></tr></thead>
          <tbody>${segRows}</tbody>
        </table>
      </div>
      <div>
        <div class="subhead"><span>硬性条件（与风格评分分开）</span><span>${cand.constraints.ok ? '全部通过' : '存在失败项'}</span></div>
        <div class="check-list">${checks}</div>
      </div>
      <div>
        <div class="subhead"><span>风格评分（仅用于排序，不改变合法性）</span><span>总分 ${(cand.style.total * 100).toFixed(1)} / 100</span></div>
        <div class="comp-grid">${comps}</div>
      </div>
      ${repairDetails}
      <div>
        <div class="subhead"><span>可重现信息</span><span>相同输入与种子 → 相同输出</span></div>
        <div class="repro">
          <div><span>engine</span><b>v${escapeHtml(repro.engineVersion)}</b></div>
          <div><span>seed</span><b>${escapeHtml(repro.seed)} → ${repro.seedHash}</b></div>
          <div><span>config hash</span><b>${repro.configHash}</b></div>
          <div><span>motif hash</span><b>${repro.motifHash}</b></div>
          <div><span>candidate hash</span><b>${repro.candidateHash ?? '—'}</b></div>
        </div>
      </div>
    </div>
  `;

  renderRoll($('detail-roll'), {
    events: annotated,
    totalBeats: cand.totalBeats,
    beatsPerBar,
    harmonyRows: cand.harmony,
    low: parsePitch($('reg-low').value) - 2,
    high: parsePitch($('reg-high').value) + 2,
    segments: cand.segments.map((s) => ({
      start: s.slotStart,
      end: s.slotStart + s.slotBudget,
      role: s.role,
      label: `${s.role} · ${s.label}`,
      color: state.colorMap.get(s.role),
    })),
    roleOrder: result.template.slots.map((s) => s.role),
  });

  $('play-chosen').dataset.index = String(state.chosenIndex);
}

function rangeLabel(range, motifLen) {
  if (range.from === 0 && range.to === motifLen - 1) return `whole motif (1–${motifLen})`;
  return `notes ${range.from + 1}–${range.to + 1} of ${motifLen}`;
}

function renderRepairDetails(result, cand) {
  // Prefer the arbitration attached to the selected candidate's own segments;
  // fall back to the engine-wide log so failures still explain themselves.
  const attached = (cand.segments ?? []).filter((s) => s.repairInfo).map((s) => s.repairInfo);
  const source = attached.length
    ? attached
    : (result.diagnostics?.slotIssues ?? []).flatMap((issue) => issue.repairLog ?? []);
  const repairs = [];
  const seen = new Set();
  for (const r of source) {
    const key = `${r.slot}|${r.transform}|${r.chosen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repairs.push({ key, ...r });
  }
  if (!repairs.length) return '';
  const rows = repairs
    .slice(0, 4)
    .map((r) => {
      const alts = r.alternatives
        .map((a) => `<span class="pill ${a.valid ? 'valid' : 'invalid'}">${escapeHtml(a.type)} · contour ${(a.contour * 100).toFixed(0)}%</span>`)
        .join(' ');
      return `
        <div class="repair-row">
          <div class="mono">${escapeHtml(r.slot)} · ${escapeHtml(r.transform)}</div>
          <div>
            选择 <b>${escapeHtml(r.chosen)}</b>（${escapeHtml(r.chosenDetail)}，轮廓保留 ${(r.contour * 100).toFixed(0)}%）
            <div style="margin-top:4px">比较候选：${alts}</div>
            <div class="mono" style="margin-top:4px;color:#7f8da3">${escapeHtml(r.preview.join(' '))}</div>
          </div>
        </div>`;
    })
    .join('');
  return `
    <div>
      <div class="subhead"><span>倒影越界时的裁决记录</span><span>八度转位 vs 局部缩短音程，按轮廓保持度选</span></div>
      <details class="repair" open>
        <summary>展开 / 收起（${repairs.length} 条，显示前 4 条）</summary>
        <div class="repair-body">${rows}</div>
      </details>
    </div>`;
}

// ---------------------------------------------------------------------------
// Playback + export
// ---------------------------------------------------------------------------

async function playCandidate(index) {
  const cand = state.result?.candidates?.[index];
  if (!cand) return;
  try {
    const schedule = await player.play(cand, {
      tempo: Number($('tempo').value) || 96,
      beatsPerBar: 4,
      metronome: $('metronome').checked,
      accompaniment: $('accompaniment').checked,
    });
    animateCursor(cand, schedule);
  } catch (err) {
    showError([`播放失败：${err.message}`]);
  }
}

let cursorTimer = null;
function animateCursor(cand, schedule) {
  clearInterval(cursorTimer);
  const host = $('detail-roll');
  if (!host) return;
  const start = performance.now();
  const totalMs = schedule.totalMs;
  cursorTimer = setInterval(() => {
    const elapsed = performance.now() - start;
    const beat = (elapsed / 1000) / schedule.secPerBeat - 0.08;
    if (elapsed > totalMs) {
      clearInterval(cursorTimer);
      const svg = host.querySelector('svg');
      svg?.querySelectorAll('.play-cursor').forEach((el) => el.remove());
      return;
    }
    const annotated = annotateEvents(cand, state.colorMap);
    renderRoll(host, {
      events: annotated,
      totalBeats: cand.totalBeats,
      beatsPerBar: 4,
      harmonyRows: cand.harmony,
      low: parsePitch($('reg-low').value) - 2,
      high: parsePitch($('reg-high').value) + 2,
      segments: cand.segments.map((s) => ({
        start: s.slotStart,
        end: s.slotStart + s.slotBudget,
        role: s.role,
        label: `${s.role} · ${s.label}`,
        color: state.colorMap.get(s.role),
      })),
      cursorBeat: Math.max(0, Math.min(cand.totalBeats, beat)),
    });
  }, 50);
}

async function playMotif() {
  try {
    const motif = readMotif();
    await player.play(
      {
        events: motif.events,
        totalBeats: Math.max(...motif.events.map((e) => e.start + e.dur)),
        harmony: [],
      },
      { tempo: Number($('tempo').value) || 96, beatsPerBar: 4, metronome: $('metronome').checked },
    );
  } catch (err) {
    showError([`播放失败：${err.message}`]);
  }
}

function exportMidi() {
  const cand = state.result?.candidates?.[state.chosenIndex];
  if (!cand) return;
  const bytes = phraseToMidi(cand, {
    tempo: Number($('tempo').value) || 96,
    beatsPerBar: 4,
    includeHarmony: true,
    includeMotif: true,
    motif: state.result.motif,
  });
  const name = `${sanitise(state.currentMotifName)}-cand${cand.rank}.mid`;
  downloadMidi(bytes, name);
  flash(`已导出 ${name}（${bytes.length} 字节，含旋律 / 和声 / 主题轨）`);
}

function exportJson() {
  const cand = state.result?.candidates?.[state.chosenIndex];
  if (!cand) return;
  const payload = {
    engineVersion: ENGINE_VERSION,
    motif: {
      id: state.result.motif.id,
      name: state.result.motif.name,
      events: state.result.motif.events,
    },
    options: state.result.options,
    template: state.result.template,
    candidate: {
      rank: cand.rank,
      events: cand.events,
      totalBeats: cand.totalBeats,
      segments: cand.segments.map((s) => ({
        role: s.role,
        label: s.label,
        slotStart: s.slotStart,
        slotBudget: s.slotBudget,
        sourceNoteRange: s.sourceNoteRange,
        ops: s.ops,
        lineage: s.lineage,
        contour: s.contour,
        events: s.events,
        verification: { ok: s.verification.ok, errors: s.verification.errors },
        classification: s.classification,
      })),
      constraints: cand.constraints,
      style: cand.style,
      reproducibility: cand.reproducibility,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitise(state.currentMotifName)}-cand${cand.rank}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash('已导出候选乐句 JSON（含完整谱系与核对结果）');
}

function flash(message) {
  const banner = $('error-banner');
  banner.hidden = false;
  banner.className = 'banner warn';
  banner.innerHTML = `<h3>提示</h3><div>${escapeHtml(message)}</div>`;
  setTimeout(() => {
    if (banner.className.includes('warn')) banner.hidden = true;
    banner.className = 'banner error';
  }, 4000);
}

function sanitise(text) {
  return text.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'phrase';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  fillSelects();
  updateMotifHint();
  $('generate').addEventListener('click', generate);
  $('reroll').addEventListener('click', () => {
    $('seed').value = `theme-${Math.floor(Math.random() * 100000)}`;
    generate();
  });
  $('motif-text').addEventListener('input', updateMotifHint);
  $('play-motif').addEventListener('click', playMotif);
  $('play-chosen').addEventListener('click', () => playCandidate(state.chosenIndex));
  $('stop').addEventListener('click', () => {
    player.stop();
    clearInterval(cursorTimer);
  });
  $('export-midi').addEventListener('click', exportMidi);
  $('export-json').addEventListener('click', exportJson);
  $('tonic').addEventListener('change', () => {
    $('ending-pc').value = $('tonic').value;
  });
  player.onstatechange = (s) => {
    const btn = $('stop');
    if (btn) btn.textContent = s === 'playing' ? '■ 播放中' : '■ 停止';
  };

  workbench = new SessionWorkbench({
    player,
    readMotif,
    readRegister: () => ({ low: parsePitch($('reg-low').value.trim()), high: parsePitch($('reg-high').value.trim()) }),
    onError: (msg) => showError([msg]),
  });
  workbench.boot();

  // Publish a tiny handle for automated UI tests.
  window.__motifApp = {
    state,
    generate,
    getResult: () => state.result,
    getChosen: () => state.result?.candidates?.[state.chosenIndex] ?? null,
    playCandidate,
    player,
    workbench,
    getSession: () => workbench.session,
  };
  generate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}

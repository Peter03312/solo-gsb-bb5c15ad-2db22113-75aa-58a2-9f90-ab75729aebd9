'use strict';

const $ = (sel) => document.querySelector(sel);
let state = { version: null, artworks: [], groups: [], slots: [], exposureRecords: [] };
let draft = [];          // 未开始时段草稿
let draftSeq = 0;        // 草稿行本地序号
let editingArtworkId = null;
let editingGroupId = null;
let finishingSlotId = null;
let correctingSlotId = null;
let correctingRecordId = null; // 正在更正分段的计划外记录
let voidingRecordId = null;    // 正在作废的计划外记录
let fnSegments = [];     // 结束弹窗分段编辑数据
let crSegments = [];     // 更正弹窗分段编辑数据
let erSegments = [];     // 计划外录入弹窗分段编辑数据
let rcSegments = [];     // 计划外更正弹窗分段编辑数据
const expandedSlots = new Set(); // 展开分段/更正记录的已结束时段
const expandedRecords = new Set(); // 展开分段/变动历史的计划外记录

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function minutes(s, e) {
  if (!s || !e) return null;
  const ms = new Date(s).getTime(), me = new Date(e).getTime();
  if (Number.isNaN(ms) || Number.isNaN(me)) return null;
  return Math.round((me - ms) / 60000);
}
function statusBadge(s) {
  if (s.status === 'running') return '<span class="badge badge-running">进行中·冻结</span>';
  if (s.status === 'finished') return '<span class="badge badge-finished">已结束</span>';
  if (s.blocked) return '<span class="badge badge-blocked">不可启动</span>';
  return '<span class="badge badge-scheduled">未开始</span>';
}
let toastTimer = null;
function toast(kind, text) {
  const el = $('#toast');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ---------- 数据加载 ----------
async function loadState(resetDraft = true) {
  state = await api('/api/state');
  $('#versionTag').textContent = `v${state.version}`;
  if (resetDraft) draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
function serverRowToDraft(s) {
  return {
    cid: `s${s.id}`,
    savedId: s.id,
    hall: s.hall,
    start: s.plannedStart,
    end: s.plannedEnd,
    lux: s.plannedLux,
    artworkIds: s.artworks.map((a) => a.id),
    blocked: s.blocked,
    blockedReason: s.blockedReason,
  };
}
function newDraftRow() {
  return { cid: `d${++draftSeq}`, hall: '', start: '', end: '', lux: 50, artworkIds: [] };
}

// ---------- 渲染：作品 ----------
function groupOfArtwork(aid) {
  return (state.groups || []).find((g) => g.members.some((m) => m.id === aid)) || null;
}
function renderArtworks() {
  const tb = $('#artworkTable tbody');
  if (!state.artworks.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="11">还没有作品，点击「录入作品」开始</td></tr>';
    return;
  }
  tb.innerHTML = state.artworks.map((a) => {
    const g = groupOfArtwork(a.id);
    return `
    <tr>
      <td class="art-name">${esc(a.name)}</td>
      <td class="num">${fmt(a.limit)}</td>
      <td class="num">${a.rollingLimit === null || a.rollingLimit === undefined ? '<span class="rolling-none">不限</span>' : fmt(a.rollingLimit)}</td>
      <td class="num">${fmt(a.existing)}</td>
      <td class="num">${fmt(a.used)}${a.unplanned ? `<span class="reserved-detail">含计划外 ${fmt(a.unplanned)}</span>` : ''}</td>
      <td class="num">${fmt(a.reserved)}<span class="reserved-detail">${fmt(a.reservedRunning)} / ${fmt(a.reservedScheduled)}</span></td>
      <td class="num">${fmt(a.committed)}</td>
      <td class="num ${a.over ? 'neg' : 'pos'}">${a.over ? '−' + fmt(Math.abs(a.balance)) : fmt(a.balance)}</td>
      <td class="note-text">${esc(a.note)}</td>
      <td>${g ? `<span class="chip">${esc(g.name)}</span>` : '—'}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="edit-art" data-id="${a.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del-art" data-id="${a.id}">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ---------- 渲染：曝光额度组 ----------
function renderGroups() {
  const tb = $('#groupTable tbody');
  const groups = state.groups || [];
  if (!groups.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">还没有额度组，点击「新建额度组」让易损作品共用一笔曝光额度</td></tr>';
    return;
  }
  tb.innerHTML = groups.map((g) => `
    <tr>
      <td class="art-name">${esc(g.name)}</td>
      <td><div class="art-chips">${g.members.length
        ? g.members.map((m) => `<span class="chip">${esc(m.name)}</span>`).join('')
        : '<span style="color:var(--muted);font-size:12px">暂无成员</span>'}</div></td>
      <td class="num">${fmt(g.limit)}</td>
      <td class="num">${fmt(g.used)}${g.unplanned ? `<span class="reserved-detail">含计划外 ${fmt(g.unplanned)}</span>` : ''}</td>
      <td class="num">${fmt(g.reserved)}<span class="reserved-detail">${fmt(g.reservedRunning)} / ${fmt(g.reservedScheduled)}</span></td>
      <td class="num">${fmt(g.committed)}</td>
      <td class="num ${g.over ? 'neg' : 'pos'}">${g.over ? '−' + fmt(Math.abs(g.balance)) : fmt(g.balance)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="edit-group" data-id="${g.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del-group" data-id="${g.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ---------- 阻断原因（单件缺口 + 组缺口 + 滚动 24h 缺口） ----------
function gapItems(reason) {
  const items = [];
  ((reason && reason.gaps) || []).forEach((g) => items.push(
    `作品「${esc(g.artworkName)}」：当前可用余额 ${fmt(g.has)}，本时段需要 ${fmt(g.need)}，缺口 <strong>${fmt(g.gap)}</strong> lux·min`));
  ((reason && reason.groupGaps) || []).forEach((g) => items.push(
    `额度组「${esc(g.groupName)}」：组可用余额 ${fmt(g.has)}，本时段需要 ${fmt(g.need)}（${g.memberCount} 件成员逐件计入），缺口 <strong>${fmt(g.gap)}</strong> lux·min`));
  ((reason && reason.rollingGaps) || []).forEach((g) => items.push(
    `作品「${esc(g.artworkName)}」<strong>滚动 24 小时</strong>超限：窗口 ${esc(String(g.windowStart).slice(5))} ~ ${esc(String(g.windowEnd).slice(5))}`
    + ` 内累计 ${fmt(g.windowExposure)}（既有 ${fmt(g.windowBaseline)} + 本时段重合 ${fmt(g.need)}），`
    + `滚动上限 ${fmt(g.cap)}，缺口 <strong>${fmt(g.gap)}</strong> lux·min`));
  return items;
}
function gapText(reason) {
  const parts = [];
  ((reason && reason.gaps) || []).forEach((g) =>
    parts.push(`「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`));
  ((reason && reason.groupGaps) || []).forEach((g) =>
    parts.push(`额度组「${g.groupName}」缺口 ${fmt(g.gap)}（组可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`));
  ((reason && reason.rollingGaps) || []).forEach((g) =>
    parts.push(`「${g.artworkName}」滚动24h缺口 ${fmt(g.gap)}（窗口 ${String(g.windowStart).slice(5)}~${String(g.windowEnd).slice(5)}，累计 ${fmt(g.windowExposure)} / 上限 ${fmt(g.cap)}）`));
  return parts.join('；');
}

// ---------- 渲染：冻结时段（进行中/已结束） ----------
function segPills(s) {
  if (!s.actualSegments || !s.actualSegments.length) return '';
  return s.actualSegments.map((g) => `
    <span class="seg-pill">${esc(String(g.start).slice(5))} ~ ${esc(String(g.end).slice(5))}
      · ${g.minutes} 分 · <b>${fmt(g.lux)}</b> lux · ${fmt(g.exposure)}</span>`).join('');
}
function correctionList(s) {
  if (!s.corrections || !s.corrections.length) return '';
  const items = s.corrections.map((c) => `
    <div class="corr-item">
      <div class="corr-head"><span>第 ${c.seqNo} 次更正</span><span>${esc(c.createdAt)}</span></div>
      <div class="corr-reason">理由：${esc(c.reason)}</div>
      <div class="corr-nums">
        曝光 ${fmt(c.before.exposure)} <span class="arrow">→</span> ${fmt(c.after.exposure)} lux·min
        ｜ 时间 ${c.before.minutes} <span class="arrow">→</span> ${c.after.minutes} 分
        ｜ 分段 ${c.before.segments.length} <span class="arrow">→</span> ${c.after.segments.length} 段
      </div>
      <div>${segPills({ actualSegments: c.after.segments })}</div>
    </div>`).join('');
  return `<div class="detail-block"><div class="detail-title">更正记录（${s.corrections.length}）</div>${items}</div>`;
}
function renderFrozen() {
  const tb = $('#frozenTable tbody');
  const rows = state.slots
    .filter((s) => s.status === 'running' || s.status === 'finished')
    .sort((a, b) => a.seq - b.seq);
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="11">暂无进行中或已结束时段</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((s) => {
    const multi = s.status === 'finished' && s.segmentCount > 1;
    const luxCell = s.actualLux === null
      ? (multi ? `多段<span class="multi-lux-hint">${s.segmentCount} 段照度</span>` : '—')
      : fmt(s.actualLux);
    const actions = s.status === 'running'
      ? `<button class="btn btn-sm btn-primary" data-act="finish" data-id="${s.id}">结束补记</button>`
      : `<div class="row-actions">
           <button class="btn btn-sm" data-act="toggle-detail" data-id="${s.id}">${expandedSlots.has(s.id) ? '收起明细' : '分段/更正'}</button>
           <button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button>
         </div>`;
    const detailOpen = expandedSlots.has(s.id);
    const detailRow = detailOpen ? `
      <tr class="detail-row">
        <td colspan="11"><div class="detail-inner">
          <div class="detail-block">
            <div class="detail-title">实际照度分段（${s.segmentCount || 0}）</div>
            ${segPills(s) || '<span style="color:var(--muted);font-size:12px">无分段数据</span>'}
          </div>
          ${correctionList(s)}
        </div></td>
      </tr>` : '';
    return `
    <tr>
      <td>${s.seq}</td>
      <td>${esc(s.hall)}</td>
      <td>${statusBadge(s)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${esc(s.plannedStart)}<br>～ ${esc(s.plannedEnd)}
      </td>
      <td class="num">${fmt(s.plannedLux)}</td>
      <td class="num">${fmt(s.plannedExposure)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${s.actualStart ? `${esc(s.actualStart)}<br>～ ${esc(s.actualEnd)}` : '—（冻结中）'}
      </td>
      <td class="num">${luxCell}</td>
      <td class="num">${s.actualExposure === null ? '—' : fmt(s.actualExposure)}</td>
      <td><div class="art-chips">${s.artworks.map((a) => `<span class="chip">${esc(a.name)}</span>`).join('')}</div></td>
      <td>${actions}</td>
    </tr>
    ${detailRow}`;
  }).join('');
}

// ---------- 渲染：未开始草稿 ----------
function renderDraft() {
  const tb = $('#scheduleTable tbody');
  if (!draft.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">没有未开始时段，点击「新增时段」，或从下方整批保存</td></tr>';
    return;
  }
  const artOptions = (selected) => state.artworks
    .map((a) => `<option value="${a.id}" ${selected.includes(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  tb.innerHTML = draft.map((r) => {
    const mins = minutes(r.start, r.end);
    const expo = mins !== null && mins >= 0 && Number(r.lux) >= 0 ? Math.round(mins * Number(r.lux)) : null;
    const items = gapItems(r.blockedReason);
    const gapHtml = items.length ? `
      <tr class="blocked-tag-row">
        <td colspan="8" class="blocked-cell">
          <strong>⛔ 预算不足，禁止启动。</strong> 调整排期后重新核算。
          <ul class="gap-list">
            ${items.map((t) => `<li>${t}</li>`).join('')}
          </ul>
        </td>
      </tr>` : '';
    return `
      <tr data-cid="${esc(r.cid)}">
        <td><input type="text" value="${esc(r.hall)}" data-f="hall" placeholder="如：一号厅" style="width:110px" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.start)}" data-f="start" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.end)}" data-f="end" /></td>
        <td><input type="number" min="0" step="1" value="${esc(r.lux)}" data-f="lux" /></td>
        <td class="num">${mins === null ? '–' : mins < 0 ? '✗' : mins}</td>
        <td class="cell-expo ${r.blocked ? 'neg' : ''}">${expo === null || expo < 0 ? '–' : fmt(expo)}</td>
        <td><select multiple size="3" data-f="artworkIds">${artOptions(r.artworkIds)}</select></td>
        <td>
          <div class="row-actions">
            ${r.savedId ? `<button class="btn btn-sm btn-primary" data-act="start" data-id="${r.savedId}">▶ 启动</button>` : ''}
            <button class="btn btn-sm btn-danger" data-act="del-draft">删除</button>
          </div>
        </td>
      </tr>
      ${gapHtml}
    `;
  }).join('');
}

// ---------- 渲染：计划外曝光记录 ----------
function recordEventList(r) {
  if (!r.events || !r.events.length) return '';
  const items = r.events.map((ev) => {
    const isVoid = ev.action === 'void';
    const nums = isVoid
      ? `状态 有效 <span class="arrow">→</span> 已作废 ｜ 曝光 ${fmt(ev.before.exposure)} lux·min 不再计入已用量`
      : `曝光 ${fmt(ev.before.exposure)} <span class="arrow">→</span> ${fmt(ev.after.exposure)} lux·min
         ｜ 时长 ${ev.before.minutes} <span class="arrow">→</span> ${ev.after.minutes} 分
         ｜ 分段 ${ev.before.segments.length} <span class="arrow">→</span> ${ev.after.segments.length} 段`;
    return `
    <div class="corr-item">
      <div class="corr-head"><span>第 ${ev.seqNo} 次变动 · ${isVoid ? '作废' : '更正分段'}</span><span>${esc(ev.createdAt)}</span></div>
      <div class="corr-reason">理由：${esc(ev.reason)}</div>
      <div class="corr-nums">${nums}</div>
      ${isVoid ? '' : `<div>${segPills({ actualSegments: ev.after.segments })}</div>`}
    </div>`;
  }).join('');
  return `<div class="detail-block"><div class="detail-title">变动记录（${r.events.length}）</div>${items}</div>`;
}
function renderRecords() {
  const tb = $('#recordTable tbody');
  const rows = state.exposureRecords || [];
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">暂无计划外曝光记录，点击「录入计划外曝光」归档布展 / 搬运中的受光</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((r) => {
    const luxCell = r.lux === null
      ? `多段<span class="multi-lux-hint">${r.segmentCount} 段照度</span>`
      : fmt(r.lux);
    const statusBadge = r.status === 'active'
      ? '<span class="badge badge-finished">有效</span>'
      : '<span class="badge badge-voided">已作废</span>';
    const toggleBtn = `<button class="btn btn-sm" data-act="toggle-rec" data-id="${r.id}">${expandedRecords.has(r.id) ? '收起明细' : '分段/变动'}</button>`;
    const actions = r.status === 'active'
      ? `<div class="row-actions">${toggleBtn}
           <button class="btn btn-sm" data-act="correct-rec" data-id="${r.id}">分段更正</button>
           <button class="btn btn-sm btn-danger" data-act="void-rec" data-id="${r.id}">作废</button>
         </div>`
      : `<div class="row-actions">${toggleBtn}</div>`;
    const detailRow = expandedRecords.has(r.id) ? `
      <tr class="detail-row">
        <td colspan="9"><div class="detail-inner">
          <div class="detail-block">
            <div class="detail-title">照度分段（${r.segmentCount}）</div>
            ${segPills({ actualSegments: r.segments }) || '<span style="color:var(--muted);font-size:12px">无分段数据</span>'}
          </div>
          ${recordEventList(r)}
        </div></td>
      </tr>` : '';
    return `
    <tr class="${r.status === 'voided' ? 'rec-voided' : ''}">
      <td>${r.id}</td>
      <td class="art-name">${esc(r.artworkName)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${esc(r.start)}<br>～ ${esc(r.end)}
      </td>
      <td class="num">${luxCell}</td>
      <td class="num">${r.minutes}</td>
      <td class="num">${fmt(r.exposure)}</td>
      <td>${statusBadge}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px">${esc(r.createdAt)}</td>
      <td>${actions}</td>
    </tr>
    ${detailRow}`;
  }).join('');
}

function renderAll() {
  renderArtworks();
  renderGroups();
  renderFrozen();
  renderRecords();
  renderDraft();
}

// ---------- 草稿交互 ----------
function syncRowFromDom(tr) {
  const cid = tr.dataset.cid;
  const row = draft.find((r) => r.cid === cid);
  if (!row) return;
  tr.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f;
    if (f === 'artworkIds') {
      row.artworkIds = Array.from(el.selectedOptions).map((o) => Number(o.value));
    } else if (f === 'lux') {
      row.lux = el.value;
    } else {
      row[f] = el.value;
    }
  });
  // 草稿一旦被改动，清除服务端的核算标记，保存后以服务端结果为准
  row.blocked = false;
  row.blockedReason = null;
  row.savedId = undefined;
}

$('#addSlotBtn').addEventListener('click', () => {
  if (!state.artworks.length) return toast('warn', '请先录入至少一件作品');
  draft.push(newDraftRow());
  renderDraft();
});
$('#resetDraftBtn').addEventListener('click', () => {
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderDraft();
});

$('#scheduleTable').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-cid]');
  if (tr) { syncRowFromDom(tr); renderDraft(); }
});
$('#scheduleTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = e.target.closest('tr[data-cid]');
  if (btn.dataset.act === 'del-draft' && tr) {
    syncRowFromDom(tr);
    draft = draft.filter((r) => r.cid !== tr.dataset.cid);
    renderDraft();
  }
  if (btn.dataset.act === 'start') {
    syncRowFromDom(tr);
    await startSlot(Number(btn.dataset.id));
  }
});

// ---------- 整批保存 ----------
function formatBatchError(payload) {
  const lines = [];
  (payload.errors || []).forEach((x) => lines.push(`• ${x.message}`));
  (payload.conflicts || []).forEach((c) => {
    const head = c.kind === 'new-record'
      ? `• 作品「${c.artworkName}」排期覆盖有效计划外曝光记录：`
      : c.kind === 'new-frozen'
        ? `• 作品「${c.artworkName}」与冻结时段重叠：`
        : `• 作品「${c.artworkName}」时段重叠：`;
    lines.push(`${head}\n    ${c.slotA.label}\n    ${c.slotB.label}`);
  });
  (payload.budgetExceeded || []).forEach((b) => {
    lines.push(`• 作品「${b.artworkName}」预算超限：已用 ${fmt(b.used)} + 预占 = ${fmt(b.projected)}，上限 ${fmt(b.limit)}，超出 ${fmt(b.overflow)} lux·min`);
  });
  (payload.groupExceeded || []).forEach((g) => {
    lines.push(`• 额度组「${g.groupName}」共用额度超限：已用 ${fmt(g.used)} + 本批预占 ${fmt(g.batchNeed)} = ${fmt(g.projected)}，组上限 ${fmt(g.limit)}，超出 ${fmt(g.overflow)} lux·min`);
    (g.members || []).forEach((m) => lines.push(`    成员「${m.artworkName}」贡献 ${fmt(m.contribution)} lux·min`));
  });
  (payload.rollingExceeded || []).forEach((g) => {
    lines.push(`• 作品「${g.artworkName}」滚动 24 小时上限 ${fmt(g.rollingLimit)} 超限：`
      + `最早超限窗口 ${g.windowStart} ~ ${g.windowEnd} 内累计 ${fmt(g.windowExposure)}`
      + `（既有/冻结/计划外 ${fmt(g.windowBaseline)} + 本批重合 ${fmt(g.windowBatchNeed)}），超出 ${fmt(g.overflow)} lux·min`
      + (g.peakOverflow !== g.overflow ? `；峰值窗口 ${g.peakWindowStart} ~ ${g.peakWindowEnd} 累计 ${fmt(g.peakWindowExposure)}，超出 ${fmt(g.peakOverflow)}` : ''));
    (g.batchSlots || []).forEach((s) => lines.push(
      `    本批时段 [${s.cid}] ${s.hall} ${s.start}~${s.end}（${s.lux} lux）窗口内重合 ${s.overlapMinutes} 分 = ${fmt(s.overlapExposure)} lux·min`));
  });
  (payload.segmentErrors || []).forEach((x) => lines.push(`• ${x}`));
  return lines.join('\n') || '整批校验失败';
}

$('#saveScheduleBtn').addEventListener('click', async () => {
  // 先把 DOM 中未触发 change 的输入同步进来
  document.querySelectorAll('#scheduleTable tbody tr[data-cid]').forEach(syncRowFromDom);
  try {
    const body = {
      version: state.version,
      slots: draft.map((r) => ({
        cid: r.cid, hall: r.hall, start: r.start, end: r.end,
        lux: r.lux === '' ? null : Number(r.lux),
        artworkIds: r.artworkIds,
      })),
    };
    const next = await api('/api/schedule', { method: 'POST', body });
    applyNewState(next);
    const blocked = next.slots.filter((s) => s.blocked);
    if (blocked.length) {
      const detail = blocked.map((s) =>
        `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gapText(s.blockedReason)}`).join('\n');
      toast('warn', `整批已保存并重新核算，以下时段按开始顺序不可启动：\n${detail}`);
    } else {
      toast('success', '整批校验通过，排期已保存');
    }
  } catch (err) {
    await handleMutationError(err);
  }
});

async function startSlot(id) {
  try {
    const next = await api(`/api/slots/${id}/start`, { method: 'POST' });
    applyNewState(next);
    toast('success', '时段已启动：原排期冻结，预占保留');
  } catch (err) {
    if (err.status === 422 && err.payload && err.payload.blockedReason) {
      toast('error', `禁止启动：预算不足\n${gapText(err.payload.blockedReason)}\n请调整排期后重新核算`);
    } else {
      toast('error', err.message);
    }
  }
}

// ---------- 分段编辑器（结束 / 更正弹窗共用） ----------
function segRowHtml(list, prefix, g, i) {
  const mins = minutes(g.start, g.end);
  const valid = mins !== null && mins > 0;
  const expo = valid && g.lux !== '' && g.lux != null && Number(g.lux) >= 0 ? Math.round(mins * Number(g.lux)) : null;
  return `
    <div class="seg-row" data-idx="${i}">
      <span class="seg-idx">${i + 1}</span>
      <input type="datetime-local" class="mono" data-seg="start" value="${esc(g.start || '')}" />
      <span>~</span>
      <input type="datetime-local" class="mono" data-seg="end" value="${esc(g.end || '')}" />
      <input type="number" class="seg-lux" data-seg="lux" min="0" step="1" value="${esc(g.lux === '' || g.lux == null ? '' : g.lux)}" placeholder="lux" title="照度 lux" />
      <span class="seg-mins">${valid ? mins + ' 分' : ''}${expo !== null ? '<br>' + fmt(expo) : ''}</span>
      <button type="button" class="seg-del" data-seg="del" title="删除该段">✕</button>
    </div>`;
}
function segMinsLabel(g) {
  const mins = minutes(g.start, g.end);
  const valid = mins !== null && mins > 0;
  const expo = valid && g.lux !== '' && g.lux != null && Number(g.lux) >= 0 ? Math.round(mins * Number(g.lux)) : null;
  return `${valid ? mins + ' 分' : ''}${expo !== null ? '<br>' + fmt(expo) : ''}`;
}
function renderSegList(container, list, prefix) {
  container.innerHTML = list.map((g, i) => segRowHtml(list, prefix, g, i)).join('');
}
function syncSegFromDom(container, list) {
  container.querySelectorAll('.seg-row').forEach((row) => {
    const i = Number(row.dataset.idx);
    if (!list[i]) return;
    row.querySelectorAll('[data-seg]').forEach((el) => {
      const f = el.dataset.seg;
      if (f === 'del') return;
      if (f === 'lux') list[i].lux = el.value === '' ? '' : Number(el.value);
      else list[i][f] = el.value;
    });
  });
}
// 仅就地刷新每行“时长/曝光”标签，不重建 DOM，避免输入时丢失焦点
function refreshSegLabels(container, list) {
  container.querySelectorAll('.seg-row').forEach((row) => {
    const i = Number(row.dataset.idx);
    const label = row.querySelector('.seg-mins');
    if (label && list[i]) label.innerHTML = segMinsLabel(list[i]);
  });
}
function segTotals(list) {
  let total = 0, valid = list.length > 0;
  for (const g of list) {
    const mins = minutes(g.start, g.end);
    if (mins === null || mins <= 0 || g.lux === '' || g.lux == null || !(Number(g.lux) >= 0)) { valid = false; continue; }
    total += mins * Number(g.lux);
  }
  return { valid, totalMins: (() => {
    let m = 0;
    for (const g of list) { const x = minutes(g.start, g.end); if (x !== null && x > 0) m += x; }
    return m;
  })(), exposure: Math.round(total) };
}
function bindSegEditor(containerId, addBtnId, listRef, onChange) {
  const container = $('#' + containerId);
  $('#' + addBtnId).addEventListener('click', () => {
    syncSegFromDom(container, listRef());
    const prev = listRef()[listRef().length - 1];
    listRef().push({ start: prev ? prev.end : '', end: '', lux: '' });
    renderSegList(container, listRef(), containerId);
    onChange();
  });
  container.addEventListener('click', (e) => {
    if (!e.target.closest('[data-seg="del"]')) return;
    const row = e.target.closest('.seg-row');
    syncSegFromDom(container, listRef());
    listRef().splice(Number(row.dataset.idx), 1);
    renderSegList(container, listRef(), containerId);
    onChange();
  });
  container.addEventListener('input', () => {
    syncSegFromDom(container, listRef());
    refreshSegLabels(container, listRef());
    onChange();
  });
  container.addEventListener('change', () => {
    syncSegFromDom(container, listRef());
    refreshSegLabels(container, listRef());
    onChange();
  });
}

// ---------- 结束补记弹窗（单一 / 多段） ----------
$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const slot = state.slots.find((s) => s.id === id);

  if (act === 'toggle-detail') {
    if (expandedSlots.has(id)) expandedSlots.delete(id); else expandedSlots.add(id);
    renderFrozen();
    return;
  }
  if (act === 'finish') {
    finishingSlotId = id;
    $('#fn_start').value = slot.plannedStart;
    $('#fn_end').value = slot.plannedEnd;
    $('#fn_lux').value = slot.plannedLux;
    document.querySelector('input[name="fn_mode"][value="single"]').checked = true;
    fnSegments = [{ start: slot.plannedStart, end: slot.plannedEnd, lux: slot.plannedLux }];
    renderSegList($('#fn_segments'), fnSegments, 'fn');
    toggleFnMode();
    $('#fn_error').classList.add('hidden');
    $('#finishModal').classList.remove('hidden');
    return;
  }
  if (act === 'correct') {
    openCorrectModal(slot);
  }
});

function toggleFnMode() {
  const mode = document.querySelector('input[name="fn_mode"]:checked').value;
  const multi = mode === 'segments';
  $('#fn_singleBox').classList.toggle('hidden', multi);
  $('#fn_segBox').classList.toggle('hidden', !multi);
  updateFinishPreview();
}
document.querySelectorAll('input[name="fn_mode"]').forEach((r) => r.addEventListener('change', () => {
  syncFinishInputs();
  toggleFnMode();
}));

function syncFinishInputs() {
  if (!document.querySelector('input[name="fn_mode"][value="segments"]').checked) return;
  syncSegFromDom($('#fn_segments'), fnSegments);
}
function updateFinishPreview() {
  const mode = document.querySelector('input[name="fn_mode"]:checked').value;
  const rangeMins = minutes($('#fn_start').value, $('#fn_end').value);
  if (mode === 'single') {
    const lux = Number($('#fn_lux').value);
    if (rangeMins !== null && rangeMins > 0 && lux >= 0) {
      $('#fn_preview').textContent = fmt(Math.round(rangeMins * lux));
      $('#fn_totalMins').textContent = rangeMins;
    } else { $('#fn_preview').textContent = '–'; $('#fn_totalMins').textContent = '–'; }
  } else {
    refreshSegLabels($('#fn_segments'), fnSegments);
    const t = segTotals(fnSegments);
    $('#fn_preview').textContent = t.valid ? fmt(t.exposure) : '–';
    $('#fn_totalMins').textContent = t.valid ? t.totalMins : '–';
  }
}
['fn_start', 'fn_end', 'fn_lux'].forEach((id) => $('#' + id).addEventListener('input', updateFinishPreview));
bindSegEditor('fn_segments', 'fn_addSeg', () => fnSegments, updateFinishPreview);

$('#fn_save').addEventListener('click', async () => {
  const mode = document.querySelector('input[name="fn_mode"]:checked').value;
  const actualStart = $('#fn_start').value;
  const actualEnd = $('#fn_end').value;
  try {
    let next;
    if (mode === 'single') {
      next = await api(`/api/slots/${finishingSlotId}/finish`, {
        method: 'POST',
        body: { actualStart, actualEnd, actualLux: Number($('#fn_lux').value) },
      });
    } else {
      syncSegFromDom($('#fn_segments'), fnSegments);
      next = await api(`/api/slots/${finishingSlotId}/settle`, {
        method: 'POST',
        body: {
          version: state.version,
          actualStart, actualEnd,
          segments: fnSegments.map((g) => ({ start: g.start, end: g.end, lux: g.lux === '' ? null : Number(g.lux) })),
        },
      });
    }
    $('#finishModal').classList.add('hidden');
    applyNewState(next);
    const expo = next.justFinishedExposure;
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      const detail = next.blockedAfterFinish.map((s) =>
        `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gapText(s.blockedReason)}`).join('\n');
      toast('warn', `已结算，实际曝光 ${fmt(expo)} lux·min 已替换预占。\n超量导致以下后续时段预算不足、不可开始：\n${detail}\n请调整排期后重新核算`);
    } else {
      toast('success', `已结束并补记，实际曝光 ${fmt(expo)} lux·min 已替换预占`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#finishModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#fn_error').textContent = err.payload && err.payload.segmentErrors
      ? err.payload.segmentErrors.map((x) => `• ${x}`).join('\n')
      : err.message;
    $('#fn_error').classList.remove('hidden');
  }
});

// ---------- 已结束时段分段更正弹窗 ----------
function openCorrectModal(slot) {
  correctingSlotId = slot.id;
  crSegments = (slot.actualSegments && slot.actualSegments.length
    ? slot.actualSegments
    : [{ start: slot.actualStart, end: slot.actualEnd, lux: slot.actualLux ?? '' }]
  ).map((g) => ({ start: g.start, end: g.end, lux: g.lux }));
  $('#cr_range').innerHTML = `原实际区间 <strong>${esc(slot.actualStart)}</strong> ～ <strong>${esc(slot.actualEnd)}</strong>`
    + `（共 ${slot.actualMinutes} 分）｜更正前曝光 <strong>${fmt(slot.actualExposure)}</strong> lux·min`;
  $('#cr_beforeExpo').textContent = fmt(slot.actualExposure);
  $('#cr_reason').value = '';
  $('#cr_error').classList.add('hidden');
  renderSegList($('#cr_segments'), crSegments, 'cr');
  updateCorrectPreview();
  $('#correctModal').classList.remove('hidden');
}
function updateCorrectPreview() {
  syncSegFromDom($('#cr_segments'), crSegments);
  const t = segTotals(crSegments);
  $('#cr_preview').textContent = t.valid ? fmt(t.exposure) : '–';
  $('#cr_totalMins').textContent = t.valid ? t.totalMins : '–';
}
bindSegEditor('cr_segments', 'cr_addSeg', () => crSegments, updateCorrectPreview);

$('#cr_save').addEventListener('click', async () => {
  syncSegFromDom($('#cr_segments'), crSegments);
  const reason = $('#cr_reason').value.trim();
  try {
    const next = await api(`/api/slots/${correctingSlotId}/correct`, {
      method: 'POST',
      body: {
        version: state.version,
        reason,
        segments: crSegments.map((g) => ({ start: g.start, end: g.end, lux: g.lux === '' ? null : Number(g.lux) })),
      },
    });
    $('#correctModal').classList.add('hidden');
    applyNewState(next);
    expandedSlots.add(correctingSlotId);
    renderFrozen();
    const c = next.correction;
    const dir = c.after.exposure - c.before.exposure;
    const head = `已提交第 ${c.seqNo} 次更正：曝光 ${fmt(c.before.exposure)} → ${fmt(c.after.exposure)} lux·min`
      + (dir === 0 ? '（总量不变）' : dir > 0 ? `（+${fmt(dir)}）` : `（−${fmt(Math.abs(dir))}）`);
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      const detail = next.blockedAfterFinish.map((s) =>
        `#${s.seq} ${s.hall}：${gapText(s.blockedReason)}`).join('\n');
      toast('warn', `${head}\n新总量已替换旧总量并重算，以下后续时段不可启动：\n${detail}`);
    } else {
      toast('success', `${head}，已用量与后续可启动状态已同步重算`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#correctModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#cr_error').textContent = err.payload && err.payload.segmentErrors
      ? err.payload.segmentErrors.map((x) => `• ${x}`).join('\n')
      : err.message;
    $('#cr_error').classList.remove('hidden');
  }
});

// ---------- 计划外曝光记录：录入 / 更正 / 作废 ----------
function recordErrorText(payload, fallback) {
  const lines = [];
  (payload.segmentErrors || []).forEach((x) => lines.push(`• ${x}`));
  (payload.conflicts || []).forEach((c) => lines.push(`• 与${c.kind === 'slot' ? '时段' : '有效记录'}冲突：${c.label}`));
  return lines.join('\n') || fallback;
}
function toastRecordResult(next, head) {
  if (next.blockedAfterRecord && next.blockedAfterRecord.length) {
    const detail = next.blockedAfterRecord.map((s) =>
      `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gapText(s.blockedReason)}`).join('\n');
    toast('warn', `${head}\n按现有顺序重算后，以下未开始时段预算不足、不可启动：\n${detail}`);
  } else {
    toast('success', `${head}，已用量与后续可启动状态已同步重算`);
  }
}

$('#addRecordBtn').addEventListener('click', () => {
  if (!state.artworks.length) return toast('warn', '请先录入至少一件作品');
  $('#er_artwork').innerHTML = state.artworks
    .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#er_start').value = '';
  $('#er_end').value = '';
  erSegments = [{ start: '', end: '', lux: '' }];
  renderSegList($('#er_segments'), erSegments, 'er');
  $('#er_error').classList.add('hidden');
  updateRecordPreview();
  $('#recordModal').classList.remove('hidden');
});
function updateRecordPreview() {
  refreshSegLabels($('#er_segments'), erSegments);
  const t = segTotals(erSegments);
  $('#er_preview').textContent = t.valid ? fmt(t.exposure) : '–';
  $('#er_totalMins').textContent = t.valid ? t.totalMins : '–';
}
bindSegEditor('er_segments', 'er_addSeg', () => erSegments, updateRecordPreview);
// 区间变化时，若只有一段则同步该段起止，便于快速录入单段记录
['er_start', 'er_end'].forEach((id) => $('#' + id).addEventListener('change', () => {
  if (erSegments.length === 1) {
    erSegments[0].start = $('#er_start').value;
    erSegments[0].end = $('#er_end').value;
    renderSegList($('#er_segments'), erSegments, 'er');
  }
  updateRecordPreview();
}));

$('#er_save').addEventListener('click', async () => {
  syncSegFromDom($('#er_segments'), erSegments);
  try {
    const next = await api('/api/exposure-records', {
      method: 'POST',
      body: {
        version: state.version,
        artworkId: Number($('#er_artwork').value),
        start: $('#er_start').value,
        end: $('#er_end').value,
        segments: erSegments.map((g) => ({ start: g.start, end: g.end, lux: g.lux === '' ? null : Number(g.lux) })),
      },
    });
    $('#recordModal').classList.add('hidden');
    applyNewState(next);
    expandedRecords.add(next.record.id);
    renderRecords();
    toastRecordResult(next,
      `已归档计划外曝光 #${next.record.id}：${fmt(next.record.exposure)} lux·min 计入「${next.record.artworkName}」已用量`);
  } catch (err) {
    if (err.status === 409) {
      $('#recordModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#er_error').textContent = recordErrorText(err.payload || {}, err.message);
    $('#er_error').classList.remove('hidden');
  }
});

$('#recordTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const rec = (state.exposureRecords || []).find((r) => r.id === id);
  if (!rec) return;
  const act = btn.dataset.act;
  if (act === 'toggle-rec') {
    if (expandedRecords.has(id)) expandedRecords.delete(id); else expandedRecords.add(id);
    renderRecords();
  }
  if (act === 'correct-rec') openRecCorrectModal(rec);
  if (act === 'void-rec') openRecVoidModal(rec);
});

// 分段更正（沿用原区间）
function openRecCorrectModal(rec) {
  correctingRecordId = rec.id;
  rcSegments = (rec.segments && rec.segments.length
    ? rec.segments
    : [{ start: rec.start, end: rec.end, lux: rec.lux ?? '' }]
  ).map((g) => ({ start: g.start, end: g.end, lux: g.lux }));
  $('#rc_range').innerHTML = `作品 <strong>${esc(rec.artworkName)}</strong> ｜ 原实际区间 <strong>${esc(rec.start)}</strong> ～ <strong>${esc(rec.end)}</strong>`
    + `（共 ${rec.minutes} 分）｜更正前曝光 <strong>${fmt(rec.exposure)}</strong> lux·min`;
  $('#rc_beforeExpo').textContent = fmt(rec.exposure);
  $('#rc_reason').value = '';
  $('#rc_error').classList.add('hidden');
  renderSegList($('#rc_segments'), rcSegments, 'rc');
  updateRecCorrectPreview();
  $('#recCorrectModal').classList.remove('hidden');
}
function updateRecCorrectPreview() {
  syncSegFromDom($('#rc_segments'), rcSegments);
  const t = segTotals(rcSegments);
  $('#rc_preview').textContent = t.valid ? fmt(t.exposure) : '–';
  $('#rc_totalMins').textContent = t.valid ? t.totalMins : '–';
}
bindSegEditor('rc_segments', 'rc_addSeg', () => rcSegments, updateRecCorrectPreview);

$('#rc_save').addEventListener('click', async () => {
  syncSegFromDom($('#rc_segments'), rcSegments);
  try {
    const next = await api(`/api/exposure-records/${correctingRecordId}/correct`, {
      method: 'POST',
      body: {
        version: state.version,
        reason: $('#rc_reason').value.trim(),
        segments: rcSegments.map((g) => ({ start: g.start, end: g.end, lux: g.lux === '' ? null : Number(g.lux) })),
      },
    });
    $('#recCorrectModal').classList.add('hidden');
    applyNewState(next);
    expandedRecords.add(correctingRecordId);
    renderRecords();
    const ev = next.recordEvent;
    toastRecordResult(next, `已提交第 ${ev.seqNo} 次更正：曝光 ${fmt(ev.before.exposure)} → ${fmt(ev.after.exposure)} lux·min（沿用原区间）`);
  } catch (err) {
    if (err.status === 409) {
      $('#recCorrectModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#rc_error').textContent = recordErrorText(err.payload || {}, err.message);
    $('#rc_error').classList.remove('hidden');
  }
});

// 作废
function openRecVoidModal(rec) {
  voidingRecordId = rec.id;
  $('#rv_info').innerHTML = `记录 <strong>#${rec.id}</strong> ｜ ${esc(rec.artworkName)}<br>`
    + `${esc(rec.start)} ～ ${esc(rec.end)} ｜ 曝光 <strong>${fmt(rec.exposure)}</strong> lux·min`;
  $('#rv_reason').value = '';
  $('#rv_error').classList.add('hidden');
  $('#recVoidModal').classList.remove('hidden');
}
$('#rv_save').addEventListener('click', async () => {
  try {
    const next = await api(`/api/exposure-records/${voidingRecordId}/void`, {
      method: 'POST',
      body: { version: state.version, reason: $('#rv_reason').value.trim() },
    });
    $('#recVoidModal').classList.add('hidden');
    applyNewState(next);
    expandedRecords.add(voidingRecordId);
    renderRecords();
    toastRecordResult(next, `记录 #${voidingRecordId} 已作废：${fmt(next.record.exposure)} lux·min 不再计入已用量`);
  } catch (err) {
    if (err.status === 409) {
      $('#recVoidModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#rv_error').textContent = recordErrorText(err.payload || {}, err.message);
    $('#rv_error').classList.remove('hidden');
  }
});

// ---------- 作品弹窗 ----------
function openArtworkModal(a) {
  editingArtworkId = a ? a.id : null;
  $('#artworkModalTitle').textContent = a ? '编辑作品' : '录入作品';
  $('#aw_name').value = a ? a.name : '';
  $('#aw_limit').value = a ? a.limit : '';
  $('#aw_rolling').value = (a && a.rollingLimit !== null && a.rollingLimit !== undefined) ? a.rollingLimit : '';
  $('#aw_existing').value = a ? a.existing : '';
  $('#aw_note').value = a ? a.note : '';
  $('#aw_error').classList.add('hidden');
  $('#artworkModal').classList.remove('hidden');
}
$('#addArtworkBtn').addEventListener('click', () => openArtworkModal(null));

$('#artworkTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'edit-art') {
    openArtworkModal(state.artworks.find((a) => a.id === id));
  }
  if (btn.dataset.act === 'del-art') {
    const a = state.artworks.find((x) => x.id === id);
    if (!confirm(`确定删除作品「${a.name}」吗？`)) return;
    try {
      const next = await api(`/api/artworks/${id}`, { method: 'DELETE', body: { version: state.version } });
      applyNewState(next);
      toast('success', '作品已删除');
    } catch (err) { await handleMutationError(err); }
  }
});

$('#aw_save').addEventListener('click', async () => {
  const rollingRaw = $('#aw_rolling').value.trim();
  const payload = {
    version: state.version,
    name: $('#aw_name').value,
    limit: Number($('#aw_limit').value),
    rollingLimit: rollingRaw === '' ? null : Number(rollingRaw),
    existing: Number($('#aw_existing').value),
    note: $('#aw_note').value,
  };
  try {
    const next = editingArtworkId
      ? await api(`/api/artworks/${editingArtworkId}`, { method: 'PUT', body: payload })
      : await api('/api/artworks', { method: 'POST', body: payload });
    applyNewState(next);
    $('#artworkModal').classList.add('hidden');
    toast('success', editingArtworkId ? '作品已更新' : '作品已录入');
  } catch (err) {
    if (err.status === 409) { $('#artworkModal').classList.add('hidden'); }
    await handleMutationError(err);
  }
});

// ---------- 额度组弹窗 ----------
function openGroupModal(g) {
  editingGroupId = g ? g.id : null;
  $('#groupModalTitle').textContent = g ? '编辑额度组' : '新建额度组';
  $('#gr_name').value = g ? g.name : '';
  $('#gr_limit').value = g ? g.limit : '';
  // 成员选项：已归属其他组的作品禁用（服务端仍会再次校验）
  const takenBy = new Map();
  (state.groups || []).forEach((x) => {
    if (g && x.id === g.id) return;
    x.members.forEach((m) => takenBy.set(m.id, x.name));
  });
  const selected = g ? g.members.map((m) => m.id) : [];
  $('#gr_members').innerHTML = state.artworks.map((a) => {
    const taken = takenBy.get(a.id);
    return `<option value="${a.id}" ${selected.includes(a.id) ? 'selected' : ''} ${taken ? 'disabled' : ''}>`
      + `${esc(a.name)}${taken ? `（已在「${esc(taken)}」）` : ''}</option>`;
  }).join('');
  $('#gr_error').classList.add('hidden');
  $('#groupModal').classList.remove('hidden');
}
$('#addGroupBtn').addEventListener('click', () => {
  if (!state.artworks.length) return toast('warn', '请先录入至少一件作品');
  openGroupModal(null);
});

$('#groupTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const g = (state.groups || []).find((x) => x.id === id);
  if (!g) return;
  if (btn.dataset.act === 'edit-group') openGroupModal(g);
  if (btn.dataset.act === 'del-group') {
    if (!confirm(`确定删除额度组「${g.name}」吗？成员作品与历史记录保留，仅解除共用额度。`)) return;
    try {
      const next = await api(`/api/groups/${id}`, { method: 'DELETE', body: { version: state.version } });
      applyNewState(next);
      toast('success', '额度组已删除，余额与不可启动时段已重算');
    } catch (err) { await handleMutationError(err); }
  }
});

$('#gr_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    name: $('#gr_name').value,
    limit: Number($('#gr_limit').value),
    memberIds: Array.from($('#gr_members').selectedOptions).map((o) => Number(o.value)),
  };
  try {
    const next = editingGroupId
      ? await api(`/api/groups/${editingGroupId}`, { method: 'PUT', body: payload })
      : await api('/api/groups', { method: 'POST', body: payload });
    applyNewState(next);
    $('#groupModal').classList.add('hidden');
    toast('success', editingGroupId ? '额度组已更新，余额与不可启动时段已重算' : '额度组已创建');
  } catch (err) {
    if (err.status === 409) { $('#groupModal').classList.add('hidden'); return handleMutationError(err); }
    $('#gr_error').textContent = err.message;
    $('#gr_error').classList.remove('hidden');
  }
});

// ---------- 通用 ----------
function applyNewState(next) {
  state = next;
  $('#versionTag').textContent = `v${state.version}`;
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
async function handleMutationError(err) {
  if (err.status === 409 && err.payload && err.payload.state) {
    applyNewState(err.payload.state);
    toast('error', `${err.message}\n本地草稿已被服务端最新预算替换，请重新调整后再提交`);
    return;
  }
  if (err.status === 422 && err.payload) toast('error', formatBatchError(err.payload));
  else toast('error', err.message);
}

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-mask').classList.add('hidden')));
document.querySelectorAll('.modal-mask').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

$('#refreshBtn').addEventListener('click', () => loadState(true).then(() => toast('success', '已刷新为最新预算')));

loadState().catch((err) => toast('error', `初始化加载失败：${err.message}`));

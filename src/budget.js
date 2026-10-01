'use strict';

// ---------- 时间 ----------
// 统一使用本地时间字符串 YYYY-MM-DDTHH:mm（HTML datetime-local 的格式）
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseDateTime(str, field) {
  if (typeof str !== 'string') {
    return { error: `${field || '时间'}格式无效，应为 YYYY-MM-DDTHH:mm` };
  }
  const m = str.trim().match(DT_RE);
  if (!m) return { error: `${field || '时间'}格式无效，应为 YYYY-MM-DDTHH:mm` };
  const [, y, mo, d, h, mi, s] = m;
  const year = +y, month = +mo, day = +d, hour = +h, min = +mi, sec = s ? +s : 0;
  const date = new Date(year, month - 1, day, hour, min, sec, 0);
  // 回卷校验（如 2 月 30 日会被 Date 自动进位，必须拒绝）
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 ||
    date.getDate() !== day || date.getHours() !== hour ||
    date.getMinutes() !== min || date.getSeconds() !== sec ||
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || min > 59 || sec > 59
  ) {
    return { error: `${field || '时间'}不是合法日期时间` };
  }
  return { date, minutes: Math.floor(date.getTime() / 60000) };
}

function minutesBetween(startStr, endStr) {
  const s = parseDateTime(startStr);
  const e = parseDateTime(endStr);
  if (s.error || e.error) return null;
  return e.minutes - s.minutes;
}

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

// Date -> 'YYYY-MM-DDTHH:mm'（本地时区，丢弃秒）
function toDTStr(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ---------- 读取 ----------
function loadArtworks(db) {
  return db.prepare('SELECT * FROM artworks ORDER BY id').all();
}

// 曝光额度组：返回组记录并挂上 memberIds（作品编号数组）
function loadGroups(db) {
  const groups = db.prepare('SELECT * FROM quota_groups ORDER BY id').all();
  const links = db.prepare('SELECT * FROM quota_group_members ORDER BY artwork_id').all();
  const byGroup = new Map();
  for (const l of links) {
    if (!byGroup.has(l.group_id)) byGroup.set(l.group_id, []);
    byGroup.get(l.group_id).push(l.artwork_id);
  }
  for (const g of groups) g.memberIds = byGroup.get(g.id) || [];
  return groups;
}

function loadSlots(db) {
  const slots = db.prepare('SELECT * FROM slots ORDER BY planned_start, seq, id').all();
  const links = db.prepare('SELECT * FROM slot_artworks').all();
  const bySlot = new Map();
  for (const l of links) {
    if (!bySlot.has(l.slot_id)) bySlot.set(l.slot_id, []);
    bySlot.get(l.slot_id).push(l.artwork_id);
  }
  for (const s of slots) {
    s.artworkIds = (bySlot.get(s.id) || []).slice();
  }
  return slots;
}

function plannedExposure(slot) {
  const mins = minutesBetween(slot.planned_start, slot.planned_end);
  if (mins === null || mins < 0) return null;
  return round3(mins * slot.planned_lux);
}

function actualExposure(slot) {
  // 分段结算优先：actual_exposure 已是分段求和值
  if (slot.status === 'finished') return slot.actual_exposure;
  if (slot.actual_start == null || slot.actual_end == null || slot.actual_lux == null) return null;
  const mins = minutesBetween(slot.actual_start, slot.actual_end);
  if (mins === null || mins < 0) return null;
  return round3(mins * slot.actual_lux);
}

// ---------- 多段照度 ----------
// 分段：[{start, end, lux}]，曝光 = Σ 各段(实际分钟 × 照度)。
// 要求：每段 start < end、lux 非负；段间首尾衔接、无重叠；首段起=区间起、末段止=区间止。
function enrichSegments(segments) {
  return (Array.isArray(segments) ? segments : []).map((g) => ({
    start: g.start, end: g.end, lux: g.lux,
    minutes: minutesBetween(g.start, g.end),
    exposure: BsegExpo(g),
  }));
}
function BsegExpo(g) {
  const mins = minutesBetween(g.start, g.end);
  if (mins === null || mins < 0 || !isNonNegNumber(g.lux)) return null;
  return round3(mins * g.lux);
}

function loadSegments(slot) {
  if (slot.actual_segments) {
    try {
      const arr = JSON.parse(slot.actual_segments);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch { /* 落库的均为可信 JSON */ }
  }
  // 兼容：旧的单一照度结算数据补成单段
  if (slot.status === 'finished' && slot.actual_start != null && slot.actual_lux != null) {
    return [{
      start: slot.actual_start, end: slot.actual_end, lux: slot.actual_lux,
      minutes: minutesBetween(slot.actual_start, slot.actual_end),
      exposure: slot.actual_exposure,
    }];
  }
  return [];
}

function segmentsTotal(segments) {
  const rich = enrichSegments(segments);
  if (!rich.length) return { minutes: 0, exposure: 0 };
  return {
    minutes: rich.reduce((n, g) => n + (g.minutes || 0), 0),
    exposure: round3(rich.reduce((n, g) => n + (g.exposure || 0), 0)),
  };
}

// 校验分段并返回富化结果（含 minutes/exposure）。不合法抛 VALIDATION 错误信息数组。
function validateSegments(rawSegments, rangeStartStr, rangeEndStr, rangeLabel = '实际区间') {
  const errs = [];
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    errs.push('segments 必须为非空数组，每段含 start、end 与非负 lux');
    return { errs };
  }
  const rich = [];
  rawSegments.forEach((raw, i) => {
    const where = () => `第 ${i + 1} 段`;
    const s = parseDateTime(raw && raw.start, `${where()} 开始时间`);
    const e = parseDateTime(raw && raw.end, `${where()} 结束时间`);
    if (s.error) errs.push(s.error);
    if (e.error) errs.push(e.error);
    if (!s.error && !e.error && e.minutes <= s.minutes) {
      errs.push(`${where()}：结束必须晚于开始`);
    }
    const lux = Number(raw && raw.lux);
    if (!isNonNegNumber(lux)) errs.push(`${where()}：照度必须为非负数值`);
    rich.push({
      raw,
      start: s.error ? null : String(raw.start).trim(),
      end: e.error ? null : String(raw.end).trim(),
      startMin: s.error ? null : s.minutes,
      endMin: e.error ? null : e.minutes,
      lux: isNonNegNumber(lux) ? lux : 0,
    });
  });
  if (errs.length) return { errs };

  const rs = parseDateTime(rangeStartStr, `${rangeLabel}开始`);
  const re = parseDateTime(rangeEndStr, `${rangeLabel}结束`);
  if (rs.error) errs.push(rs.error);
  if (re.error) errs.push(re.error);
  if (!rs.error && !re.error && re.minutes <= rs.minutes) {
    errs.push(`${rangeLabel}：结束必须晚于开始`);
  }
  if (errs.length) return { errs };

  // 衔接与覆盖：要求提交顺序本身即为时间顺序，避免歧义。
  for (let i = 0; i < rich.length; i++) {
    const g = rich[i];
    if (i === 0) {
      if (g.startMin !== rs.minutes) {
        errs.push(`分段未完整覆盖${rangeLabel}：首段开始 ${g.start} 必须等于${rangeLabel}开始 ${rangeStartStr}`);
      }
    } else if (g.startMin !== rich[i - 1].endMin) {
      const kind = g.startMin < rich[i - 1].endMin ? '存在重叠' : '存在缺口';
      errs.push(`第 ${i + 1} 段开始 ${g.start} 必须与第 ${i} 段结束 ${rich[i - 1].end} 首尾衔接（${kind}）`);
    } else if (g.endMin <= g.startMin) {
      errs.push(`第 ${i + 1} 段：结束必须晚于开始`);
    }
  }
  // 末尾覆盖（逐段严格递延时，起点已衔接即等价，单独再校验一次保证完整）
  if (!errs.length && rich[rich.length - 1].endMin !== re.minutes) {
    const g = rich[rich.length - 1];
    errs.push(`分段未完整覆盖${rangeLabel}：末段结束 ${g.end} 必须等于${rangeLabel}结束 ${rangeEndStr}`);
  }
  if (errs.length) return { errs };

  const normalized = rich.map((g) => {
    const minutes = g.endMin - g.startMin;
    return {
      start: g.start, end: g.end, lux: g.lux, minutes,
      exposure: round3(minutes * g.lux),
    };
  });
  return {
    segments: normalized,
    minutes: normalized.reduce((n, g) => n + g.minutes, 0),
    exposure: round3(normalized.reduce((n, g) => n + g.exposure, 0)),
  };
}

// 单段时给出代表性照度（供 DTO 的 actualLux 字段）；多段返回 null
function representativeLux(segments) {
  return segments.length === 1 ? segments[0].lux : null;
}

// ---------- 滚动 24 小时曝光上限 ----------
// 对任意连续 24 小时窗口（分钟精度，半开区间 [t, t+1440)）累计作品曝光：
//   已结束时段取实际分段、进行中取冻结计划、未开始取计划、有效计划外记录取归档分段；
//   跨窗口边界的分段按重合分钟拆分；同一作品的各时段 / 记录逐条相加。
const ROLLING_WINDOW_MINUTES = 24 * 60;

const windowMinToStr = (m) => toDTStr(new Date(m * 60000));

// 已结束时段 -> 实际照度分段（分钟区间）
function finishedSlotPieces(slot) {
  return loadSegments(slot)
    .map((g) => {
      const s = parseDateTime(g.start);
      const e = parseDateTime(g.end);
      if (s.error || e.error) return null;
      return { start: s.minutes, end: e.minutes, lux: g.lux };
    })
    .filter((g) => g && g.end > g.start && isNonNegNumber(g.lux));
}

// 未开始 / 进行中时段 -> 冻结（计划）照度分段（分钟区间，整段一个照度）
function plannedSlotPieces(slot) {
  if (slot.status === 'finished') return finishedSlotPieces(slot);
  const s = parseDateTime(slot.planned_start);
  const e = parseDateTime(slot.planned_end);
  if (s.error || e.error || e.minutes <= s.minutes || !isNonNegNumber(slot.planned_lux)) return [];
  return [{ start: s.minutes, end: e.minutes, lux: slot.planned_lux }];
}

// 有效计划外曝光记录 -> 归档照度分段（分钟区间）
function exposureRecordPieces(rec) {
  return parseJsonArr(rec.segments)
    .map((g) => {
      const s = parseDateTime(g.start);
      const e = parseDateTime(g.end);
      if (s.error || e.error) return null;
      return { start: s.minutes, end: e.minutes, lux: g.lux };
    })
    .filter((g) => g && g.end > g.start && isNonNegNumber(g.lux));
}

// 窗口 [wStart, wEnd) 内的累计曝光：跨边界分段按重合分钟拆分后求和
function windowExposureAt(pieces, wStart, wEnd) {
  let total = 0;
  for (const p of pieces) {
    const lo = Math.max(p.start, wStart);
    const hi = Math.min(p.end, wEnd);
    if (hi > lo) total += (hi - lo) * p.lux;
  }
  return total;
}

// 窗口与这些分段是否有至少 1 分钟重合（用于限定“本批 / 本时段参与的窗口”）
function windowTouches(pieces, wStart, wEnd) {
  return pieces.some((p) => Math.min(p.end, wEnd) - Math.max(p.start, wStart) > 0);
}

// 分钟 x（半开区间 [x, x+1)）处作品承受的照度之和（同一作品多条分段时逐条相加）
function luxAtMinute(pieces, x) {
  let s = 0;
  for (const p of pieces) if (p.start <= x && x < p.end) s += p.lux;
  return s;
}

// 扫描作品的滚动窗口曝光。
// pieces：参与累计的全部分段；focus：只考察与这些分段（本批 / 本时段）重合的窗口，
// null 表示全部窗口。返回：
//   earliest —— 最早超限窗口（整批拒绝时指出“最早超限窗口及超额量”）
//   worst    —— 超额量最大的窗口（启动阻断时给出滚动缺口）
function scanRollingWindows(pieces, limit, focus = null) {
  if (!pieces.length || !isNonNegNumber(limit)) return { earliest: null, worst: null };
  // 仅整数分钟起点、且与 focus 至少重合 1 分钟的窗口：t ∈ [start-W+1, end-1]
  const lo = focus ? Math.min(...focus.map((p) => p.start - ROLLING_WINDOW_MINUTES + 1))
    : Math.min(...pieces.map((p) => p.start - ROLLING_WINDOW_MINUTES + 1));
  const hi = focus ? Math.max(...focus.map((p) => p.end - 1))
    : Math.max(...pieces.map((p) => p.end - 1));
  if (hi < lo) return { earliest: null, worst: null };

  // F(t)=窗口[t,t+W)累计在 t 越过任一分段边界（左边界 p.start/p.end，
  // 或右边界 p.start-W/p.end-W）时改变斜率；事件之间 F(t) 为线性。
  const events = new Set([lo, hi + 1]);
  for (const p of pieces) {
    events.add(p.start).add(p.end);
    events.add(p.start - ROLLING_WINDOW_MINUTES).add(p.end - ROLLING_WINDOW_MINUTES);
  }
  const E = [...events].filter((t) => t >= lo && t <= hi + 1).sort((a, b) => a - b);

  let earliest = null;
  let worst = null;
  const consider = (t) => {
    const total = round3(windowExposureAt(pieces, t, t + ROLLING_WINDOW_MINUTES));
    if (!(total > limit + 1e-9)) return;
    const hit = {
      windowStartMin: t,
      windowStart: windowMinToStr(t),
      windowEnd: windowMinToStr(t + ROLLING_WINDOW_MINUTES),
      total,
      overflow: round3(total - limit),
    };
    if (!earliest || t < earliest.windowStartMin) earliest = hit;
    if (!worst || hit.overflow > worst.overflow + 1e-9) worst = hit;
  };

  for (let i = 0; i < E.length - 1; i++) {
    const e = E[i];
    if (e > hi) break;
    const next = E[i + 1];
    const last = Math.min(next - 1, hi);
    const fe = windowExposureAt(pieces, e, e + ROLLING_WINDOW_MINUTES);
    if (fe > limit + 1e-9) {
      consider(e);
      continue;
    }
    if (last > e) {
      // 斜率 = 右边界进入照度 − 左边界离开照度；斜率为正时区间末端最大
      const slope = luxAtMinute(pieces, e + ROLLING_WINDOW_MINUTES) - luxAtMinute(pieces, e);
      if (slope > 0) {
        const fEnd = fe + (last - e) * slope;
        if (fEnd > limit + 1e-9) {
          // 首个严格超限的整数分钟：(t-e)*slope > limit-fe
          const k = Math.floor((limit - fe) / slope) + 1;
          if (e + k <= last) consider(e + k);
          consider(last);
        }
      }
    }
  }
  return { earliest, worst };
}

// 找出每件作品的最早超限滚动窗口。
// piecesByArt：Map<artworkId, 分段数组>（全部参与累计的来源）
// limitByArt：Map<artworkId, 非负上限>（无上限 / null 的作品跳过）
// focusByArt：可选 Map<artworkId, 分段数组>；给出后只保留与这些分段（本批未开始 / 本时段）
//             至少重合 1 分钟的窗口——即仅校验“本批未开始时段参与的窗口”。
// 返回 [{artworkId, windowStart, windowEnd, dailyLimit, total, overflow}]，
// 按窗口开始时间（再按作品）排序。
function earliestRollingExceed(piecesByArt, limitByArt, focusByArt = null) {
  const exceeded = [];
  for (const [aid, fixed] of piecesByArt) {
    const limit = limitByArt.get(aid);
    if (!isNonNegNumber(limit)) continue;
    const focus = focusByArt ? focusByArt.get(aid) : null;
    if (focusByArt && (!focus || !focus.length)) continue;
    // 窗口累计包含全部来源：已确定分段 + 本批（或本时段）分段；focus 同时限定只校验其参与的窗口
    const pieces = focus ? fixed.concat(focus) : fixed;
    if (!pieces.length) continue;
    const { earliest } = scanRollingWindows(pieces, limit, focus);
    if (earliest) exceeded.push({ artworkId: aid, dailyLimit: limit, ...earliest });
  }
  return exceeded.sort((a, b) => a.windowStartMin - b.windowStartMin || a.artworkId - b.artworkId);
}

// ---------- 更正记录 ----------
function loadCorrections(db) {
  const rows = db.prepare('SELECT * FROM slot_corrections ORDER BY slot_id, seq_no, id').all();
  const dto = (r) => ({
    id: r.id,
    slotId: r.slot_id,
    seqNo: r.seq_no,
    reason: r.reason,
    createdAt: r.created_at,
    before: {
      start: r.before_start, end: r.before_end, lux: r.before_lux,
      minutes: r.before_minutes, exposure: r.before_exposure,
      segments: parseJsonArr(r.before_segments),
    },
    after: {
      start: r.after_start, end: r.after_end, lux: r.after_lux,
      minutes: r.after_minutes, exposure: r.after_exposure,
      segments: parseJsonArr(r.after_segments),
    },
  });
  return rows.map(dto);
}
function parseJsonArr(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ---------- 计划外曝光记录 ----------
function loadExposureRecords(db) {
  return db.prepare('SELECT * FROM exposure_records ORDER BY start_time, id').all();
}

function loadExposureRecordEvents(db) {
  const rows = db.prepare('SELECT * FROM exposure_record_events ORDER BY record_id, seq_no, id').all();
  return rows.map((r) => ({
    id: r.id,
    recordId: r.record_id,
    seqNo: r.seq_no,
    action: r.action,           // correct 更正分段 / void 作废
    reason: r.reason,
    createdAt: r.created_at,
    before: {
      status: r.before_status, lux: r.before_lux,
      minutes: r.before_minutes, exposure: r.before_exposure,
      segments: parseJsonArr(r.before_segments),
    },
    after: {
      status: r.after_status, lux: r.after_lux,
      minutes: r.after_minutes, exposure: r.after_exposure,
      segments: parseJsonArr(r.after_segments),
    },
  }));
}

function exposureRecordDto(r, artworksById, eventsByRecord) {
  const segments = parseJsonArr(r.segments);
  const a = artworksById.get(r.artwork_id);
  return {
    id: r.id,
    artworkId: r.artwork_id,
    artworkName: a ? a.name : `#${r.artwork_id}`,
    start: r.start_time,
    end: r.end_time,
    lux: r.lux,
    minutes: r.minutes,
    exposure: r.exposure,
    segments,
    segmentCount: segments.length,
    status: r.status,           // active 有效 / voided 已作废
    createdAt: r.created_at,
    events: eventsByRecord ? (eventsByRecord.get(r.id) || []) : [],
  };
}

function slotDto(slot, artworksById, correctionsBySlot) {
  const planned = plannedExposure(slot);
  const actual = slot.status === 'finished' ? slot.actual_exposure : actualExposure(slot);
  const segList = slot.status === 'finished' ? loadSegments(slot) : [];
  let blockedReason = null;
  try { blockedReason = JSON.parse(slot.blocked_reason || '{}'); } catch { blockedReason = {}; }
  return {
    id: slot.id,
    hall: slot.hall,
    seq: slot.seq,
    status: slot.status,
    plannedStart: slot.planned_start,
    plannedEnd: slot.planned_end,
    plannedLux: slot.planned_lux,
    plannedMinutes: planned === null ? null : minutesBetween(slot.planned_start, slot.planned_end),
    plannedExposure: planned,
    actualStart: slot.actual_start,
    actualEnd: slot.actual_end,
    actualLux: representativeLux(segList),
    actualMinutes: actual === null ? null
      : (segList.length ? segmentsTotal(segList).minutes : minutesBetween(slot.actual_start, slot.actual_end)),
    actualExposure: actual,
    actualSegments: segList,
    segmentCount: segList.length,
    corrections: correctionsBySlot ? (correctionsBySlot.get(slot.id) || []) : [],
    blocked: !!slot.blocked,
    blockedReason,
    artworks: slot.artworkIds.map((id) => {
      const a = artworksById.get(id);
      return { id, name: a ? a.name : `#${id}` };
    }),
  };
}

// ---------- 汇总 ----------
function summarize(db) {
  const artworks = loadArtworks(db);
  const slots = loadSlots(db);
  const artworksById = new Map(artworks.map((a) => [a.id, a]));
  const correctionsBySlot = new Map();
  for (const c of loadCorrections(db)) {
    if (!correctionsBySlot.has(c.slotId)) correctionsBySlot.set(c.slotId, []);
    correctionsBySlot.get(c.slotId).push(c);
  }
  const exposureRecords = loadExposureRecords(db);
  const eventsByRecord = new Map();
  for (const ev of loadExposureRecordEvents(db)) {
    if (!eventsByRecord.has(ev.recordId)) eventsByRecord.set(ev.recordId, []);
    eventsByRecord.get(ev.recordId).push(ev);
  }

  const acc = new Map();
  for (const a of artworks) {
    acc.set(a.id, { used: a.existing_amount, reservedRunning: 0, reservedScheduled: 0, unplanned: 0 });
  }

  for (const slot of slots) {
    const expo = plannedExposure(slot);
    const actual = slot.status === 'finished' ? slot.actual_exposure : null;
    for (const aid of slot.artworkIds) {
      if (!acc.has(aid)) continue;
      const row = acc.get(aid);
      if (slot.status === 'finished') row.used += actual || 0;
      else if (slot.status === 'running') row.reservedRunning += expo || 0;
      else row.reservedScheduled += expo || 0; // 含被标记为不可启动的时段
    }
  }

  // 有效计划外曝光计入作品已用量（历史实耗，允许使余额为负）
  for (const r of exposureRecords) {
    if (r.status !== 'active') continue;
    const row = acc.get(r.artwork_id);
    if (!row) continue;
    row.used += r.exposure;
    row.unplanned += r.exposure;
  }

  const artworkDtos = artworks.map((a) => {
    const r = acc.get(a.id);
    const used = round3(r.used);
    const reserved = round3(r.reservedRunning + r.reservedScheduled);
    const committed = round3(used + reserved);
    const balance = round3(a.limit_amount - committed);
    return {
      id: a.id,
      name: a.name,
      limit: a.limit_amount,
      dailyLimit: a.daily_limit_amount == null ? null : a.daily_limit_amount,
      existing: a.existing_amount,
      note: a.note,
      used,
      unplanned: round3(r.unplanned),
      reserved,
      reservedRunning: round3(r.reservedRunning),
      reservedScheduled: round3(r.reservedScheduled),
      committed,
      balance,
      over: balance < 0,
    };
  });

  // 额度组汇总：组已用 = 成员既有累计 + 已结束实际曝光 + 有效计划外曝光；预占 = 进行中冻结 + 未开始计划；
  // 同一时段有多件组内作品时逐件计入（成员各自累计，组取成员之和）。
  const groupDtos = loadGroups(db).map((g) => {
    let used = 0, reservedRunning = 0, reservedScheduled = 0, unplanned = 0;
    for (const aid of g.memberIds) {
      const r = acc.get(aid);
      if (!r) continue;
      used += r.used;
      reservedRunning += r.reservedRunning;
      reservedScheduled += r.reservedScheduled;
      unplanned += r.unplanned;
    }
    used = round3(used);
    const reserved = round3(reservedRunning + reservedScheduled);
    const committed = round3(used + reserved);
    const balance = round3(g.limit_amount - committed);
    return {
      id: g.id,
      name: g.name,
      limit: g.limit_amount,
      members: g.memberIds.map((aid) => {
        const a = artworksById.get(aid);
        return { id: aid, name: a ? a.name : `#${aid}` };
      }),
      used,
      unplanned: round3(unplanned),
      reserved,
      reservedRunning: round3(reservedRunning),
      reservedScheduled: round3(reservedScheduled),
      committed,
      balance,
      over: balance < 0,
    };
  });

  return {
    version: db.prepare('SELECT version FROM meta WHERE id = 1').get().version,
    artworks: artworkDtos,
    groups: groupDtos,
    slots: slots.map((s) => slotDto(s, artworksById, correctionsBySlot)),
    exposureRecords: exposureRecords.map((r) => exposureRecordDto(r, artworksById, eventsByRecord)),
  };
}

// ---------- 预算核算：按开始时间/编号顺序标记不可启动的时段 ----------
// 规则：按时序逐个尝试放入未开始时段，任一关联作品余额不足、或所属额度组余额不足，
// 即标记为不可启动并记下缺口；被标记的时段视为不会启动，不再占用后续预算。
// 组上限低于已用量时：历史（已结束）与进行中状态保留，仅后续未开始时段被阻止启动。
function recomputeBlocked(db) {
  const slots = loadSlots(db);
  const artworks = loadArtworks(db);
  const groups = loadGroups(db);
  const artworksById = new Map(artworks.map((a) => [a.id, a]));
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  const names = new Map(artworks.map((a) => [a.id, a.name]));
  const limits = new Map(artworks.map((a) => [a.id, a.limit_amount]));
  // 作品级滚动 24 小时曝光上限：null 表示不限制
  const dailyLimits = new Map(artworks.map((a) => [a.id, a.daily_limit_amount == null ? null : a.daily_limit_amount]));

  // 组维度：作品 -> 组；组已用从成员既有累计量起算
  const groupOf = new Map();   // artworkId -> groupId
  const groupUsed = new Map();
  const groupLimit = new Map();
  const groupName = new Map();
  for (const g of groups) {
    groupLimit.set(g.id, g.limit_amount);
    groupName.set(g.id, g.name);
    let base = 0;
    for (const aid of g.memberIds) {
      groupOf.set(aid, g.id);
      const a = artworksById.get(aid);
      if (a) base += a.existing_amount;
    }
    groupUsed.set(g.id, base);
  }
  const addGroup = (aid, expo) => {
    const gid = groupOf.get(aid);
    if (gid != null) groupUsed.set(gid, groupUsed.get(gid) + expo);
  };

  // 滚动窗口：按作品收集“已确定”的照度分段（已结束实际分段 + 进行中冻结计划）
  const piecesByArt = new Map(artworks.map((a) => [a.id, []]));
  const appendPiece = (aid, p) => {
    const list = piecesByArt.get(aid);
    if (list) list.push(p);
  };

  for (const s of slots) {
    if (s.status === 'finished') {
      for (const aid of s.artworkIds) {
        if (used.has(aid)) used.set(aid, used.get(aid) + (s.actual_exposure || 0));
        addGroup(aid, s.actual_exposure || 0);
        finishedSlotPieces(s).forEach((p) => appendPiece(aid, p));
      }
    } else if (s.status === 'running') {
      const expo = plannedExposure(s) || 0;
      for (const aid of s.artworkIds) {
        if (used.has(aid)) used.set(aid, used.get(aid) + expo);
        addGroup(aid, expo);
        plannedSlotPieces(s).forEach((p) => appendPiece(aid, p));
      }
    }
  }

  // 有效计划外曝光：与已结束时段同属历史实耗，计入已用基线（允许余额为负）；
  // 归档分段同样进入滚动 24 小时窗口累计。
  for (const r of loadExposureRecords(db)) {
    if (r.status !== 'active') continue;
    if (used.has(r.artwork_id)) used.set(r.artwork_id, used.get(r.artwork_id) + r.exposure);
    addGroup(r.artwork_id, r.exposure);
    exposureRecordPieces(r).forEach((p) => appendPiece(r.artwork_id, p));
  }

  const ordered = slots
    .filter((s) => s.status === 'scheduled')
    .sort((a, b) =>
      minutesBetween('2000-01-01T00:00', a.planned_start) - minutesBetween('2000-01-01T00:00', b.planned_start) ||
      a.seq - b.seq || a.id - b.id
    );

  const upd = db.prepare('UPDATE slots SET blocked = ?, blocked_reason = ? WHERE id = ?');
  for (const s of ordered) {
    const expo = plannedExposure(s) || 0;
    // 本时段计划分段（每件关联作品各一条，同照度逐件计入）
    const slotPiecesByArt = new Map();
    for (const aid of s.artworkIds) {
      if (!piecesByArt.has(aid)) continue;
      plannedSlotPieces(s).forEach((p) => {
        if (!slotPiecesByArt.has(aid)) slotPiecesByArt.set(aid, []);
        slotPiecesByArt.get(aid).push(p);
      });
    }

    const gaps = [];
    for (const aid of s.artworkIds) {
      if (!used.has(aid)) continue;
      const projected = used.get(aid) + expo;
      if (projected > limits.get(aid) + 1e-9) {
        gaps.push({
          artworkId: aid,
          artworkName: names.get(aid),
          has: round3(limits.get(aid) - used.get(aid)),         // 当前可用余额
          need: round3(expo),                                    // 本时段需求
          gap: round3(projected - limits.get(aid)),              // 缺口
        });
      }
    }
    // 组维度：同一时段有多件组内作品时逐件计入（需求 = 曝光 × 组内成员数）
    const groupGaps = [];
    const touch = new Map();   // groupId -> 本时段内该组成员件数
    for (const aid of s.artworkIds) {
      const gid = groupOf.get(aid);
      if (gid != null) touch.set(gid, (touch.get(gid) || 0) + 1);
    }
    for (const [gid, count] of touch) {
      const need = round3(expo * count);
      const projected = groupUsed.get(gid) + need;
      if (projected > groupLimit.get(gid) + 1e-9) {
        groupGaps.push({
          groupId: gid,
          groupName: groupName.get(gid),
          has: round3(groupLimit.get(gid) - groupUsed.get(gid)),  // 组当前可用余额（可为负）
          need,                                                    // 本时段对组的需求（逐件计入）
          gap: round3(projected - groupLimit.get(gid)),            // 组缺口
          memberCount: count,
        });
      }
    }
    // 滚动 24 小时缺口：仅校验本时段（本未开始时段）参与的窗口
    const rollingGaps = rollingGapsForSlot(piecesByArt, dailyLimits, slotPiecesByArt, names);
    if (gaps.length > 0 || groupGaps.length > 0 || rollingGaps.length > 0) {
      upd.run(1, JSON.stringify({ gaps, groupGaps, rollingGaps }), s.id);
      // 不可启动：不占用后续滚动额度
    } else {
      upd.run(0, '{}', s.id);
      for (const aid of s.artworkIds) {
        if (used.has(aid)) used.set(aid, used.get(aid) + expo);
        addGroup(aid, expo);
        const mine = slotPiecesByArt.get(aid);
        if (mine) piecesByArt.get(aid).push(...mine);
      }
    }
  }
  // 进行中 / 已结束时段不参与“不可启动”标记
  db.prepare("UPDATE slots SET blocked = 0, blocked_reason = '{}' WHERE status != 'scheduled'").run();
}

// 评估一个候选未开始时段的滚动 24 小时上限：对每件设置了上限的作品，
// 在“已确定分段 + 已接受的未开始分段 + 本时段分段”中，只看与本时段重合的窗口；
// 取缺口（窗口累计 − 上限）最大的窗口作为阻断依据。
function rollingGapsForSlot(piecesByArt, dailyLimits, slotPiecesByArt, names) {
  const rollingGaps = [];
  for (const [aid, focusList] of slotPiecesByArt) {
    const limit = dailyLimits.get(aid);
    if (!isNonNegNumber(limit)) continue;
    const pieces = (piecesByArt.get(aid) || []).concat(focusList);
    const { worst } = scanRollingWindows(pieces, limit, focusList);
    if (worst) {
      rollingGaps.push({
        artworkId: aid,
        artworkName: names.get(aid),
        dailyLimit: limit,
        windowStart: worst.windowStart,
        windowEnd: worst.windowEnd,
        total: worst.total,
        overflow: worst.overflow,
      });
    }
  }
  return rollingGaps;
}

function bumpVersion(db) {
  db.prepare('UPDATE meta SET version = version + 1 WHERE id = 1').run();
}

module.exports = {
  parseDateTime,
  toDTStr,
  minutesBetween,
  round3,
  isNonNegNumber,
  loadArtworks,
  loadGroups,
  loadSlots,
  loadCorrections,
  loadSegments,
  loadExposureRecords,
  loadExposureRecordEvents,
  exposureRecordDto,
  enrichSegments,
  segmentsTotal,
  validateSegments,
  representativeLux,
  plannedExposure,
  actualExposure,
  ROLLING_WINDOW_MINUTES,
  plannedSlotPieces,
  finishedSlotPieces,
  exposureRecordPieces,
  windowExposureAt,
  windowTouches,
  scanRollingWindows,
  earliestRollingExceed,
  summarize,
  recomputeBlocked,
  bumpVersion,
};

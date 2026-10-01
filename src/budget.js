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

// ---------- 滚动 24 小时曝光上限 ----------
// 可选的作品级约束：任意连续 24 小时（1440 分钟）窗口内，按分钟精度累计的曝光不得超过上限。
// 累计口径（同一作品逐段相加）：已结束时段取实际分段；进行中取冻结计划（单段）；
// 未开始取计划（单段）；有效计划外记录取归档分段。既有累计量没有时间区间，不参与滚动核算。
const ROLLING_WINDOW_MINUTES = 1440;

// 均匀照度分段（分钟整数坐标）：{startMin, endMin, lux}，半开区间 [startMin, endMin)
function pushTimelinePiece(list, startMin, endMin, lux) {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || !(endMin > startMin)) return;
  list.push({ startMin, endMin, lux: Number(lux) || 0 });
}

function parseMin(str) {
  const p = parseDateTime(str);
  return p.error ? null : p.minutes;
}

// 时段 -> 滚动时间线分段（已结束取实际分段；进行中 / 未开始取冻结 / 计划单段）
function slotTimelinePieces(slot) {
  const out = [];
  if (slot.status === 'finished') {
    for (const g of loadSegments(slot)) {
      pushTimelinePiece(out, parseMin(g.start), parseMin(g.end), g.lux);
    }
  } else {
    pushTimelinePiece(out, parseMin(slot.planned_start), parseMin(slot.planned_end), slot.planned_lux);
  }
  return out;
}

// 有效计划外记录 -> 滚动时间线分段（归档分段；兼容单段 lux 字段）
function recordTimelinePieces(r) {
  const out = [];
  const segs = parseJsonArr(r.segments);
  if (segs.length) {
    for (const g of segs) pushTimelinePiece(out, parseMin(g.start), parseMin(g.end), g.lux);
  } else {
    pushTimelinePiece(out, parseMin(r.start_time), parseMin(r.end_time), r.lux);
  }
  return out;
}

// 窗口 [w, w + W) 内各分段按重合分钟拆分后的累计曝光
function windowExposureAt(pieces, w, W = ROLLING_WINDOW_MINUTES) {
  const we = w + W;
  let total = 0;
  for (const p of pieces) {
    const a = Math.max(p.startMin, w);
    const b = Math.min(p.endMin, we);
    if (b > a) total += (b - a) * (Number(p.lux) || 0);
  }
  return round3(total);
}

// 候选分段（本批 / 待核算时段）在窗口内的重合曝光
function candidateWindowNeed(candidates, w, W = ROLLING_WINDOW_MINUTES) {
  const we = w + W;
  let total = 0;
  for (const p of candidates) {
    const a = Math.max(p.startMin, w);
    const b = Math.min(p.endMin, we);
    if (b > a) total += (b - a) * (Number(p.lux) || 0);
  }
  return round3(total);
}

// 在“与候选分段有重合”的全部整数窗口起点中，求窗口曝光的最大值。
// F(w) 关于整数 w 分段线性，斜率只在窗口边界越过任一分段端点时改变，
// 因此只需检查各分段端点对应的窗口起点 {p.s, p.e, p.s-W, p.e-W}（再夹到重合范围内）。
function rollingBreakpoints(pieces, W) {
  const set = new Set();
  for (const p of pieces) {
    set.add(p.startMin); set.add(p.endMin);
    set.add(p.startMin - W); set.add(p.endMin - W);
  }
  return set;
}

// 候选相关的整数窗口起点范围：w ∈ [lo, hi] 时窗口与至少一个候选段重合
function candidateWindowRange(candidates, W) {
  let lo = Infinity, hi = -Infinity;
  for (const c of candidates) {
    // 整数窗口起点 w 与候选段 [s,e) 有重合 ⇔ s-W < w < e，即 w ∈ [s-W+1, e-1]
    lo = Math.min(lo, c.startMin - W + 1);
    hi = Math.max(hi, c.endMin - 1);
  }
  return hi < lo ? null : { lo, hi };
}

function candidateStartSet(pieces, candidates, range, W) {
  const { lo, hi } = range;
  const starts = new Set([lo, hi]);
  for (const w of rollingBreakpoints(pieces.concat(candidates), W)) {
    if (w >= lo && w <= hi) starts.add(w);
  }
  for (const c of candidates) {
    if (c.startMin >= lo && c.startMin <= hi) starts.add(c.startMin);
    const w2 = c.endMin - W;
    if (w2 >= lo && w2 <= hi) starts.add(w2);
  }
  return starts;
}

function maxRollingWindow(pieces, candidates, W = ROLLING_WINDOW_MINUTES) {
  if (!candidates.length) return null;
  const range = candidateWindowRange(candidates, W);
  if (!range) return null;
  const all = pieces.concat(candidates);
  let best = null;
  for (const w of candidateStartSet(pieces, candidates, range, W)) {
    const value = windowExposureAt(all, w, W);
    if (best === null || value > best.value + 1e-9) {
      best = { windowStartMin: w, value };
    }
  }
  if (!best) return null;
  return { windowStartMin: best.windowStartMin, value: round3(best.value) };
}

// 与候选分段重合的全部超限窗口中，取起点最早者（并附带峰值窗口信息）。
// F(w) 在相邻断点之间为线性（斜率恒定），逐区间用线性求交得到精确的最早整数越限起点。
// 返回 {first:{windowStartMin,windowEndMin,exposure,need,overflow}, peak:{...}} 或 null。
function rollingViolation(pieces, candidates, limit, W = ROLLING_WINDOW_MINUTES) {
  if (!candidates.length) return null;
  const range = candidateWindowRange(candidates, W);
  if (!range) return null;
  const { lo, hi } = range;
  const all = pieces.concat(candidates);
  const bp = Array.from(candidateStartSet(pieces, candidates, range, W)).sort((a, b) => a - b);

  let first = null, peak = null;
  for (let i = 0; i < bp.length; i++) {
    const w0 = bp[i];
    const f0 = windowExposureAt(all, w0, W);
    // 斜率：窗口起点右移 1 分钟时总曝光的变化量（本区间内恒定）
    const slope = windowExposureAt(all, w0 + 1, W) - f0;
    const wEnd = i + 1 < bp.length ? bp[i + 1] : w0;

    // 峰值只可能出现在线性区间端点
    for (const w of (wEnd === w0 ? [w0] : [w0, wEnd])) {
      const exposure = w === w0 ? f0 : windowExposureAt(all, w, W);
      if (!peak || exposure > peak.exposure + 1e-9) {
        peak = { windowStartMin: w, exposure };
      }
    }

    if (first) continue;
    let wOver = null;
    if (f0 > limit + 1e-9) {
      wOver = w0;
    } else if (slope > 1e-9) {
      // 最小整数 δ≥0 使 f0 + slope·δ > limit
      const delta = Math.floor((limit - f0) / slope) + 1;
      const cand = w0 + delta;
      if (cand <= wEnd && f0 + slope * delta > limit + 1e-9) wOver = cand;
    }
    if (wOver != null) {
      const exposure = windowExposureAt(all, wOver, W);
      if (exposure > limit + 1e-9) {
        first = {
          windowStartMin: wOver, windowEndMin: wOver + W,
          exposure, need: candidateWindowNeed(candidates, wOver, W),
          overflow: round3(exposure - limit),
        };
      }
    }
  }
  if (!first) return null;
  first.exposure = round3(first.exposure);
  first.need = round3(first.need);
  peak.exposure = round3(peak.exposure);
  return {
    first,
    peak: {
      windowStartMin: peak.windowStartMin, windowEndMin: peak.windowStartMin + W,
      exposure: peak.exposure,
      need: round3(candidateWindowNeed(candidates, peak.windowStartMin, W)),
      overflow: round3(peak.exposure - limit),
    },
  };
}

function minToDTStr(m) {
  return toDTStr(new Date(m * 60000));
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
      rollingLimit: a.rolling_limit == null ? null : a.rolling_limit,
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

  // 滚动 24 小时时间线基线（按作品累计分段）：已结束实际分段 + 进行中冻结计划 + 有效计划外归档分段。
  // 未开始时段在下方按时序逐个尝试：通过核算的分段并入时间线，被阻断时段不占后续滚动额度。
  const rollingLimit = new Map();   // artworkId -> 非空滚动上限
  for (const a of artworks) {
    if (a.rolling_limit != null) rollingLimit.set(a.id, a.rolling_limit);
  }
  const rollingPieces = new Map(artworks.map((a) => [a.id, []]));
  const addRolling = (aid, pieces) => {
    const list = rollingPieces.get(aid);
    if (list) for (const p of pieces) list.push(p);
  };

  for (const s of slots) {
    if (s.status === 'finished') {
      const pieces = slotTimelinePieces(s);
      for (const aid of s.artworkIds) {
        if (used.has(aid)) used.set(aid, used.get(aid) + (s.actual_exposure || 0));
        addGroup(aid, s.actual_exposure || 0);
        addRolling(aid, pieces);
      }
    } else if (s.status === 'running') {
      const expo = plannedExposure(s) || 0;
      const pieces = slotTimelinePieces(s);
      for (const aid of s.artworkIds) {
        if (used.has(aid)) used.set(aid, used.get(aid) + expo);
        addGroup(aid, expo);
        addRolling(aid, pieces);
      }
    }
  }

  // 有效计划外曝光：与已结束时段同属历史实耗，计入已用基线（允许余额为负），并并入滚动时间线
  for (const r of loadExposureRecords(db)) {
    if (r.status !== 'active') continue;
    if (used.has(r.artwork_id)) used.set(r.artwork_id, used.get(r.artwork_id) + r.exposure);
    addGroup(r.artwork_id, r.exposure);
    addRolling(r.artwork_id, recordTimelinePieces(r));
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
    // 滚动 24 小时维度：对设置了滚动上限的每件关联作品，把该时段计划单段作为候选，
    // 检查含本时段的滚动窗口峰值；结算 / 更正 / 计划外记录 / 下调上限造成的历史超限保留事实，
    // 仅在本时段参与时产生缺口并阻断启动。
    const rollingGaps = [];
    const startMin = parseMin(s.planned_start);
    const endMin = parseMin(s.planned_end);
    for (const aid of s.artworkIds) {
      const cap = rollingLimit.get(aid);
      if (cap == null) continue;
      const candidate = [{ startMin, endMin, lux: s.planned_lux }];
      const hit = maxRollingWindow(rollingPieces.get(aid) || [], candidate);
      if (hit && hit.value > cap + 1e-9) {
        const baseline = windowExposureAt(rollingPieces.get(aid) || [], hit.windowStartMin);
        rollingGaps.push({
          artworkId: aid,
          artworkName: names.get(aid),
          cap: round3(cap),
          windowStart: minToDTStr(hit.windowStartMin),
          windowEnd: minToDTStr(hit.windowStartMin + ROLLING_WINDOW_MINUTES),
          windowBaseline: round3(baseline),                        // 窗口内除本时段外的既有曝光（可为负余额口径之外的值）
          windowExposure: hit.value,                               // 窗口峰值曝光（含本时段）
          need: round3(hit.value - baseline),                      // 本时段在峰值窗口中的重合曝光
          has: round3(cap - baseline),                             // 峰值窗口剩余滚动额度（可为负）
          gap: round3(hit.value - cap),                            // 滚动缺口
        });
      }
    }
    if (gaps.length > 0 || groupGaps.length > 0 || rollingGaps.length > 0) {
      upd.run(1, JSON.stringify({ gaps, groupGaps, rollingGaps }), s.id);
      // 不可启动：不占用后续预算（含滚动额度）
    } else {
      upd.run(0, '{}', s.id);
      for (const aid of s.artworkIds) {
        if (used.has(aid)) used.set(aid, used.get(aid) + expo);
        addGroup(aid, expo);
        // 通过核算的时段占用后续滚动额度
        if (rollingLimit.has(aid) && startMin != null && endMin != null) {
          (rollingPieces.get(aid) || []).push({ startMin, endMin, lux: s.planned_lux });
        }
      }
    }
  }
  // 进行中 / 已结束时段不参与“不可启动”标记
  db.prepare("UPDATE slots SET blocked = 0, blocked_reason = '{}' WHERE status != 'scheduled'").run();
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
  summarize,
  recomputeBlocked,
  bumpVersion,
  ROLLING_WINDOW_MINUTES,
  slotTimelinePieces,
  recordTimelinePieces,
  windowExposureAt,
  maxRollingWindow,
  rollingViolation,
  minToDTStr,
};

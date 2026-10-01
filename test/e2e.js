'use strict';
// 端到端规则验证（使用临时内存数据库逻辑通过 HTTP 接口验证）
const BASE = process.env.BASE || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({})).then((j) => j || {});
  return { status: res.status, json };
}
const getState = async () => (await call('GET', '/api/state')).json;

(async () => {
  console.log('# 1. 整批校验：负值 / 无效时序');
  let r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'a', hall: 'X', start: '2026-10-05T10:00', end: '2026-10-05T09:00', lux: 100, artworkIds: [3] },
    { cid: 'b', hall: 'Y', start: '2026-10-06T10:00', end: '2026-10-06T11:00', lux: -5, artworkIds: [3] },
    { cid: 'c', hall: 'Z', start: '2026-02-30T10:00', end: '2026-10-06T11:00', lux: 5, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.errors.length === 3, `拒绝三种无效输入（得到 ${r.status}, ${r.json.errors?.length} 条）`);
  let st = await getState();
  ok(st.version === 1, '被拒绝后版本不变、数据不变');

  console.log('# 2. 同作品时段重叠（新-新 / 新-冻结）');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'p1', hall: '二号厅', start: '2026-10-10T10:00', end: '2026-10-10T12:00', lux: 100, artworkIds: [3] },
    { cid: 'p2', hall: '三号厅', start: '2026-10-10T11:00', end: '2026-10-10T13:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.length === 1, '新时段互相重叠被拒绝');
  ok(r.json.conflicts[0].artworkId === 3 && r.json.conflicts[0].slotA.cid === 'p1', '冲突指出作品与两个时段');

  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'f1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [1] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '与进行中冻结时段重叠被拒绝');
  // 不同作品同一时间允许
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'ok1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '不同作品同展厅时间重叠允许（仅按作品约束）');

  console.log('# 3. 预算超限整批拒绝');
  st = await getState(); // version 现在 2
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'big', hall: '四号厅', start: '2026-11-01T08:00', end: '2026-11-01T20:00', lux: 500, artworkIds: [2] },
  ]});
  ok(r.status === 422 && r.json.budgetExceeded?.[0]?.artworkId === 2,
     `超量拒绝并指出作品与超出值（overflow=${r.json.budgetExceeded?.[0]?.overflow}）`);
  st = await getState();
  ok(st.version === 2, '超量拒绝后版本不变');

  console.log('# 4. 过期版本并发拒绝');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'v', hall: '五号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 10, artworkIds: [3] },
  ]});
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === 2,
     `过期版本返回 409 与最新预算（state v${r.json.state?.version}）`);

  console.log('# 5. 合法整批保存 + 版本递增 + 重新编号');
  r = await call('POST', '/api/schedule', { version: 2, slots: [
    { cid: 'x', hall: '二号厅', start: '2026-10-20T10:00', end: '2026-10-20T12:00', lux: 120, artworkIds: [1, 2] },
    { cid: 'y', hall: '三号厅', start: '2026-10-19T09:00', end: '2026-10-19T10:00', lux: 80, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.version === 3, `整批保存成功，版本→${r.json.version}`);
  const sched = r.json.slots.filter((s) => s.status === 'scheduled').sort((a, b) => a.seq - b.seq);
  ok(sched.length === 2 && sched[0].hall === '三号厅' && sched[0].seq === 3 && sched[1].seq === 4,
     '按开始时间重新编号（冻结时段在前）');
  ok(sched.every((s) => !s.blocked), '预算充足：无不可启动时段');

  console.log('# 6. 启动进行中时段不允许 / 启动未开始时段');
  const target = sched[0]; // 三号厅 W3
  r = await call('POST', `/api/slots/2/start`);
  ok(r.status === 422 && r.json.error?.code === 'NOT_STARTABLE', '已在进行中的时段不能再次启动');
  r = await call('POST', `/api/slots/${target.id}/start`);
  ok(r.status === 200, '未开始时段可启动');
  st = r.json;
  const running3 = st.slots.find((s) => s.id === target.id);
  ok(running3.status === 'running', '状态变为进行中');
  ok(st.version === 4, '启动后版本 +1');
  // 启动后再保存排期：该时段必须从可编辑集合消失，且仍不可被重叠
  r = await call('POST', '/api/schedule', { version: 4, slots: [
    { cid: 'ov', hall: '三号厅', start: '2026-10-19T09:30', end: '2026-10-19T10:30', lux: 50, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '启动后冻结：新排期与其重叠被拒');
  // 空批次合法
  r = await call('POST', '/api/schedule', { version: 4, slots: [] });
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').length === 0, '空批次合法（清空未开始排期）');

  console.log('# 7. 结束补记：无效时序拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T10:00', actualEnd: '2026-10-19T09:00', actualLux: 100,
  });
  ok(r.status === 422, '实际结束早于开始被拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T09:00', actualEnd: '2026-10-19T10:00', actualLux: -1,
  });
  ok(r.status === 422, '负照度被拒绝');

  console.log('# 8. 超量结算 → 后续时段按顺序标为不可启动并禁止启动');
  // 先重建排期：W1、W2 在进行中时段(2号 240min*200)之后
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'w1s', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T12:00', lux: 180, artworkIds: [1] }, // 21600
    { cid: 'w2s', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T13:00', lux: 150, artworkIds: [2, 3] }, // 27000
    { cid: 'w3s', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] }, // 19800
  ]});
  ok(r.status === 200, '恢复三条未开始时段');
  const beforeFinish = r.json;
  const w1Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-01'));
  const w2Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-02'));
  ok(!w1Slot.blocked && !w2Slot.blocked, '结算前均可启动');

  // 结束 slot 2（W1+W2），实际 300 lux × 240 = 72000，远超冻结预占 48000
  r = await call('POST', '/api/slots/2/finish', {
    actualStart: '2026-09-30T09:00', actualEnd: '2026-09-30T13:00', actualLux: 300,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 72000, `实际曝光 ${r.json.justFinishedExposure} 替换预占`);
  // W1: 12000+22400+72000 = 106400, 余 13600 < 21600 → 缺口 8000
  // W2: 20000+72000 = 92000, 余 8000 < 27000 → 缺口 19000
  const blockedIds = r.json.blockedAfterFinish.map((s) => s.id);
  ok(blockedIds.length === 2 && blockedIds[0] === w1Slot.id,
     `按开始顺序标出不可开始时段：#${r.json.blockedAfterFinish.map((s) => s.seq).join(', #')}`);
  const g1 = w1Slot ? r.json.blockedAfterFinish.find((s) => s.id === w1Slot.id).blockedReason.gaps[0] : null;
  ok(g1 && g1.artworkId === 1 && g1.gap === 8000 && g1.has === 13600 && g1.need === 21600,
     `W1 缺口数据正确（has=${g1?.has}, need=${g1?.need}, gap=${g1?.gap}）`);

  // 尝试启动被拦截时段
  r = await call('POST', `/api/slots/${w1Slot.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.gaps[0].gap === 8000,
     '预算不足时段禁止启动并返回缺口');

  // W3 时段（10-03）：由于 w2s 联展 W3 但被跳过（不占预算），W3 独立时段应仍可启动
  const w3Only = r.json ? null : null;
  st = await getState();
  const w3slot = st.slots.find((s) => s.plannedStart.startsWith('2026-10-03'));
  ok(!w3slot.blocked, '被拦截时段不占预算，后续预算充足的时段仍标记可启动（贪婪核算）');

  console.log('# 9. 调整排期后重新核算，缺口消除');
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    // W1 缩短到 60 分钟 × 180 = 10800 <= 13600
    { cid: 'w1f', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T11:00', lux: 180, artworkIds: [1] },
    // W2 降到 50 lux × 60 = 3000 <= 8000，同时联展 W3
    { cid: 'w2f', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T11:00', lux: 50, artworkIds: [2, 3] },
    { cid: 'w3f', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked),
     '调整后重新核算：所有时段均可启动');
  st = r.json;
  const w1Final = st.slots.find((s) => s.plannedStart.startsWith('2026-10-01'));
  r = await call('POST', `/api/slots/${w1Final.id}/start`);
  ok(r.status === 200, '调整后时段可以启动');

  console.log('# 10. 作品校验：既有>上限拒绝；重复名拒绝；被引用时删除拒绝');
  st = await getState(); // #9 的启动操作又递增过版本，重新取最新版本
  r = await call('POST', '/api/artworks', { version: st.version, name: '测试品', limit: 100, existing: 200 });
  ok(r.status === 422, '既有累计超过上限拒绝');
  r = await call('POST', '/api/artworks', { version: st.version, name: '《山水轴》纸本水墨', limit: 100, existing: 0 });
  ok(r.status === 422, '作品名重复拒绝');
  r = await call('DELETE', '/api/artworks/1', { version: st.version });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '被时段引用的作品不可删除');

  console.log('# 11. 合法作品增删改');
  r = await call('POST', '/api/artworks', { version: st.version, name: '新增测试品', limit: 5000, existing: 100, note: 'hi' });
  ok(r.status === 200, '新作品录入成功');
  const newId = r.json.artworks.at(-1).id;
  r = await call('PUT', `/api/artworks/${newId}`, { version: r.json.version, name: '新增测试品改', limit: 6000, existing: 200, note: 'x' });
  ok(r.status === 200 && r.json.artworks.at(-1).limit === 6000, '作品更新成功');
  r = await call('DELETE', `/api/artworks/${newId}`, { version: r.json.version });
  ok(r.status === 200 && !r.json.artworks.some((a) => a.id === newId), '未被引用的作品可删除');

  console.log('# 12. 多段照度结算：分段完整性校验（衔接/覆盖/非负）');
  st = await getState();
  // 独立演示作品，避免与前面步骤的数据耦合
  r = await call('POST', '/api/artworks', { version: st.version, name: '分段测试品', limit: 200000, existing: 0 });
  ok(r.status === 200, '分段测试作品已创建');
  const segArtId = r.json.artworks.at(-1).id;
  let v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'seg-a', hall: '四号厅', start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100, artworkIds: [segArtId] },
    { cid: 'seg-b', hall: '四号厅', start: '2026-11-10T14:00', end: '2026-11-10T16:00', lux: 100, artworkIds: [segArtId] },
  ]});
  ok(r.status === 200, '两个测试时段已排期');
  v = r.json.version;
  const segA = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-10T09'));
  const segB = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-10T14'));
  r = await call('POST', `/api/slots/${segA.id}/start`);
  ok(r.status === 200, '测试时段 A 已启动');
  v = r.json.version;

  const settlePath = `/api/slots/${segA.id}/settle`;
  // 缺口：两段之间空 10 分钟
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:10', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID' && r.json.segmentErrors.length >= 1,
     '分段有缺口被整批拒绝');
  // 重叠
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:30', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('衔接')), '分段重叠被拒绝');
  // 未覆盖到区间末尾
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:30', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('完整覆盖')), '分段未完整覆盖实际区间被拒绝');
  // 负照度
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: -1 },
  ]});
  ok(r.status === 422, '分段负照度被拒绝');
  // 空数组
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [] });
  ok(r.status === 422, '空分段被拒绝');
  // 零长度中间段（末段恰好等于区间结束，也不能漏网）
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('结束必须晚于开始')), '零长度中间段被拒绝');
  // 末段被包含在前段内（前段已到区间结束）→ 重叠
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('重叠')), '末段与前段重叠（区间被超过）被拒绝');
  // 乱序提交（第 2 段在第 1 段之前）→ 缺口
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('缺口') || m.includes('覆盖')), '分段未按时间顺序提交被拒绝');
  st = await getState();
  ok(st.version === v, '分段拒绝不改变结算与版本');

  // 过期版本 → 409 + 最新预算
  r = await call('POST', settlePath, { version: 1, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
     '多段结算过期版本返回 409 与最新预算');

  console.log('# 13. 多段结算成功：Σ(分钟×照度)，返回分段与总量');
  // 60*120 + 30*200 + 30*0 = 7200 + 6000 + 0 = 13200
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 120 },
    { start: '2026-11-10T10:00', end: '2026-11-10T10:30', lux: 200 },
    { start: '2026-11-10T10:30', end: '2026-11-10T11:00', lux: 0 },
  ]});
  ok(r.status === 200 && r.json.justFinishedExposure === 13200 && r.json.justFinishedMinutes === 120
     && r.json.justFinishedSegments.length === 3,
     `多段结算总量 ${r.json.justFinishedExposure}（应 13200）、时长 ${r.json.justFinishedMinutes} 分、3 段`);
  v = r.json.version;
  const settledA = r.json.slots.find((s) => s.id === segA.id);
  ok(settledA.status === 'finished' && settledA.actualLux === null && settledA.segmentCount === 3
     && settledA.actualSegments[2].exposure === 0,
     '多段结算后状态 finished、无单一照度、含 0 照度段');
  const segArt = r.json.artworks.find((a) => a.id === segArtId);
  ok(segArt.used === 13200, `作品已用 = 分段曝光之和 ${segArt.used}`);
  // 已结束时段不能再 settle
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '已结束时段不能再次结算');

  console.log('# 14. 已结束时段分段更正：理由/覆盖校验/替换语义/记录');
  const correctPath = `/api/slots/${segA.id}/correct`;
  // 缺理由
  r = await call('POST', correctPath, { version: v, segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 110 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '无理由更正被拒绝');
  // 分段不覆盖原实际区间
  r = await call('POST', correctPath, { version: v, reason: 'x', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '更正分段未覆盖原区间被拒绝');
  // 过期版本
  r = await call('POST', correctPath, { version: 1, reason: 'x', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 110 },
  ]});
  ok(r.status === 409 && r.json.state.version === v, '更正过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.slots.find((s) => s.id === segA.id).actualExposure === 13200, '更正失败不改结算与版本');

  // 合法更正：改为两段 60*110 + 60*130 = 6600 + 7800 = 14400（替换 13200，不累加）
  r = await call('POST', correctPath, { version: v, reason: '照度计复核：开场调暗、随后恢复', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 130 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 1
     && r.json.correction.before.exposure === 13200 && r.json.correction.after.exposure === 14400
     && r.json.correction.before.segments.length === 3 && r.json.correction.after.segments.length === 2,
     '更正记录含更正前后曝光(13200→14400)、时间与分段数');
  v = r.json.version;
  const afterArt = r.json.artworks.find((a) => a.id === segArtId);
  ok(afterArt.used === 14400, `新总量替换旧总量、不重复累计：已用 ${afterArt.used}（应 14400）`);
  const afterSlot = r.json.slots.find((s) => s.id === segA.id);
  ok(afterSlot.actualExposure === 14400 && afterSlot.corrections.length === 1
     && afterSlot.corrections[0].reason.includes('照度计复核')
     && afterSlot.corrections[0].before.minutes === 120 && afterSlot.corrections[0].after.minutes === 120,
     '时段 DTO 携带更正记录（理由与前后时间）');

  console.log('# 15. 更正影响后续时段不可启动状态与缺口，再更正恢复');
  // segB（14:00–16:00，120 分钟）先启动前应可启动；当前已用 14400，上限 200000 充足 → 启动它
  r = await call('POST', `/api/slots/${segB.id}/start`);
  ok(r.status === 200, '测试时段 B 可启动');
  v = r.json.version;
  // 把 segA 更正为 199000：120 分钟单一照度，超出后 B 已在进行中（不标 blocked），
  // 这里改为验证未开始时段：再排一个 segC
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'seg-c', hall: '五号厅', start: '2026-11-11T09:00', end: '2026-11-11T10:00', lux: 100, artworkIds: [segArtId] },
  ]});
  ok(r.status === 200, '测试时段 C 已排期（60*100=6000）');
  v = r.json.version;
  const segC = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-11'));
  // 已用 14400（A）+ B 进行中预占 12000 = 26400；C 需 6000 → 当前可启动
  ok(!segC.blocked, '更正前 C 可启动');

  // 更正 A：120 分钟 * 1900 = 228000？上限 200000，会导致 B+C 全部超量；
  // 但 B 进行中预占固定 12000。C 判定时基线 = 1900*120 + 12000 = 240000 > 200000 → 缺口
  r = await call('POST', correctPath, { version: v, reason: '发现长期超照度，补登实测', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 1900 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 2, '第二次更正成功（seqNo=2）');
  v = r.json.version;
  const blockedC = r.json.blockedAfterFinish.find((s) => s.id === segC.id);
  ok(!!blockedC && blockedC.blockedReason.gaps[0].artworkId === segArtId,
     `更正后后续未开始时段被标不可启动，缺口 ${blockedC?.blockedReason.gaps[0].gap}`);
  const artOver = r.json.artworks.find((a) => a.id === segArtId);
  ok(artOver.used === 228000 && artOver.over === true, '更正后作品已用量同步重算为 228000');
  // 启动被拦截
  r = await call('POST', `/api/slots/${segC.id}/start`);
  ok(r.status === 422 && r.json.error.code === 'BLOCKED', '更正致缺口后 C 禁止启动');

  // 再更正回低照度：缺口消除
  r = await call('POST', correctPath, { version: v, reason: '复核为照度记录仪故障，恢复实测值', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 130 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 3
     && r.json.correction.before.exposure === 228000 && r.json.correction.after.exposure === 14400
     && r.json.blockedAfterFinish.length === 0,
     '第三次更正 228000→14400，缺口消除、后续时段恢复可启动');
  st = await getState();
  const restoredC = st.slots.find((s) => s.id === segC.id);
  ok(!restoredC.blocked && st.artworks.find((a) => a.id === segArtId).used === 14400,
     '恢复更正后 C 可启动、作品已用量回到 14400、更正记录共 3 条');
  ok(st.slots.find((s) => s.id === segA.id).corrections.length === 3, '更正历史累计 3 条且只增不改');

  console.log('# 16. 演示数据自带分段与更正记录');
  st = await getState();
  ok(st.slots.find((s) => s.id === 1).segmentCount === 2
     && st.slots.find((s) => s.id === 1).actualLux === null
     && st.slots.find((s) => s.id === 1).corrections.length >= 1
     && st.slots.find((s) => s.id === 1).actualExposure === 22400,
     '初始已结束时段为多段结算（2 段、合计 22400）并带更正记录');

  console.log('# 17. 额度组录入校验：重复/不存在/跨组占用/负上限/重名/空名 + 版本冲突');
  st = await getState();
  v = st.version;
  ok(st.groups.length === 1 && st.groups[0].name === '纸本联展共用额度'
     && st.groups[0].members.map((m) => m.id).join(',') === '1,2',
     '演示数据自带额度组（成员为两件纸本作品）');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: 100, memberIds: [segArtId, segArtId] });
  ok(r.status === 422, '组内成员重复被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: 100, memberIds: [999999] });
  ok(r.status === 422, '成员作品不存在被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: -5, memberIds: [] });
  ok(r.status === 422, '组上限为负被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: '  ', limit: 100, memberIds: [] });
  ok(r.status === 422, '组名称为空被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: '纸本联展共用额度', limit: 100, memberIds: [] });
  ok(r.status === 422, '组名称重复被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: 100, memberIds: [1] });
  ok(r.status === 422 && /已归属/.test(r.json.error?.message || ''), '作品已归属其他组被拒绝（每件作品至多一组）');
  r = await call('POST', '/api/groups', { version: 1, name: 'Y组', limit: 100, memberIds: [] });
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === v,
     '组配置过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.groups.length === 1, '组校验失败不改版本与记录');

  console.log('# 18. 创建额度组成功：聚合已用/预占/余额；成员作品不可删除');
  r = await call('POST', '/api/groups', { version: v, name: '巡展摄影共用额度', limit: 100000, memberIds: [segArtId] });
  ok(r.status === 200 && r.json.version === v + 1, `额度组创建成功，版本→${r.json.version}`);
  let grp = r.json.groups.find((g) => g.name === '巡展摄影共用额度');
  ok(grp && grp.used === 14400 && grp.reservedRunning === 12000 && grp.reservedScheduled === 6000
     && grp.committed === 32400 && grp.balance === 67600 && grp.over === false,
     `组聚合正确（已用 ${grp?.used} / 预占 ${grp?.reserved} / 余额 ${grp?.balance}）`);
  const grpId = grp.id;
  v = r.json.version;
  r = await call('POST', '/api/groups', { version: v, name: '再抢一次', limit: 100, memberIds: [segArtId] });
  ok(r.status === 422 && /已归属/.test(r.json.error?.message || ''), '同一作品不能加入第二个组');
  // 组成员作品删除被拒；移出组后可删
  r = await call('POST', '/api/artworks', { version: v, name: '组删除测试品', limit: 1000, existing: 0 });
  const tmpArt = r.json.artworks.at(-1).id;
  v = r.json.version;
  r = await call('POST', '/api/groups', { version: v, name: '临时组', limit: 1000, memberIds: [tmpArt] });
  const tmpGrp = r.json.groups.find((g) => g.name === '临时组').id;
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${tmpArt}`, { version: v });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '组成员作品删除被拒绝（IN_USE）');
  r = await call('DELETE', `/api/groups/${tmpGrp}`, { version: v });
  ok(r.status === 200, '空组可删除');
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${tmpArt}`, { version: v });
  ok(r.status === 200, '移出组后作品可删除');
  v = r.json.version;

  console.log('# 19. 整批排期：单件未超但组超限 → 整批拒绝并指出组、成员贡献、超额量');
  // segArt 单件：已用 14400 + 进行中 12000 = 26400，上限 200000；组上限 100000
  // 本批 6000 + 132000 = 138000 → 单件 164400 未超，组 164400 超 64400
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'c1', hall: '五号厅', start: '2026-11-11T09:00', end: '2026-11-11T10:00', lux: 100, artworkIds: [segArtId] },
    { cid: 'big', hall: '六号厅', start: '2026-11-13T09:00', end: '2026-11-13T20:00', lux: 200, artworkIds: [segArtId] },
  ]});
  const ge = r.json.groupExceeded?.[0];
  ok(r.status === 422 && (!r.json.budgetExceeded || r.json.budgetExceeded.length === 0)
     && ge && ge.groupId === grpId && ge.overflow === 64400
     && ge.used === 26400 && ge.batchNeed === 138000 && ge.projected === 164400
     && ge.members.length === 1 && ge.members[0].artworkId === segArtId && ge.members[0].contribution === 164400,
     `组超限拒绝：指出组、成员贡献 ${ge?.members?.[0]?.contribution} 与超额量 ${ge?.overflow}`);
  st = await getState();
  ok(st.version === v, '组超限拒绝后版本不变');

  console.log('# 20. 调低组上限 + 结算更正 → 组缺口阻断后续启动（单件仍充足）');
  r = await call('PUT', `/api/groups/${grpId}`, { version: v, name: '巡展摄影共用额度', limit: 40000, memberIds: [segArtId] });
  ok(r.status === 200, '组上限调低到 40000（≥ 当前已用 26400）成功');
  v = r.json.version;
  let segCnow = r.json.slots.find((s) => s.id === segC.id);
  ok(!segCnow.blocked, '组 26400 + 6000 = 32400 ≤ 40000：C 仍可启动');
  // 更正 segA 为 120 分钟 × 300 = 36000：组基线变为 36000 + 12000 = 48000 > 40000
  r = await call('POST', `/api/slots/${segA.id}/correct`, { version: v, reason: '照度计复核：实测偏高', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 300 },
  ]});
  ok(r.status === 200 && r.json.correction.after.exposure === 36000, '更正成功（14400→36000）');
  v = r.json.version;
  const blockedC2 = r.json.blockedAfterFinish.find((s) => s.id === segC.id);
  const gg = blockedC2?.blockedReason?.groupGaps?.[0];
  ok(!!blockedC2 && blockedC2.blockedReason.gaps.length === 0
     && gg && gg.groupId === grpId && gg.has === -8000 && gg.need === 6000 && gg.gap === 14000 && gg.memberCount === 1,
     `更正后按现有时序重算：C 被组缺口阻断（组可用 ${gg?.has} / 需 ${gg?.need} / 缺口 ${gg?.gap}）`);
  r = await call('POST', `/api/slots/${segC.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.groupGaps?.[0]?.gap === 14000,
     '组缺口时段禁止启动并返回组缺口');

  console.log('# 21. 组上限低于已用量：历史与进行中保留，仅阻止后续启动并展示缺口');
  r = await call('PUT', `/api/groups/${grpId}`, { version: v, name: '巡展摄影共用额度', limit: 20000, memberIds: [segArtId] });
  ok(r.status === 200, '组上限允许调低到已用量以下（20000 < 48000）');
  v = r.json.version;
  grp = r.json.groups.find((g) => g.id === grpId);
  ok(grp.used === 36000 && grp.reservedRunning === 12000 && grp.committed === 54000
     && grp.balance === -34000 && grp.over === true,
     `组余额为负并展示缺口（余额 ${grp?.balance}）`);
  ok(r.json.slots.find((s) => s.id === segA.id).status === 'finished'
     && r.json.slots.find((s) => s.id === segA.id).actualExposure === 36000
     && r.json.slots.find((s) => s.id === segB.id).status === 'running',
     '已结束历史与进行中状态保留不变');
  segCnow = r.json.slots.find((s) => s.id === segC.id);
  ok(segCnow.blocked && segCnow.blockedReason.groupGaps?.[0]?.gap === 34000,
     `仅后续未开始时段被阻止（组缺口 ${segCnow.blockedReason.groupGaps?.[0]?.gap}）`);

  console.log('# 22. 组配置版本冲突 + 删除组后重算恢复');
  r = await call('PUT', `/api/groups/${grpId}`, { version: 1, name: '巡展摄影共用额度', limit: 999999, memberIds: [segArtId] });
  ok(r.status === 409 && r.json.state.version === v, '组更新过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.groups.find((g) => g.id === grpId).limit === 20000, '版本冲突失败不改版本与记录');
  r = await call('DELETE', `/api/groups/${grpId}`, { version: v });
  ok(r.status === 200 && !r.json.groups.some((g) => g.id === grpId), '额度组已删除');
  v = r.json.version;
  ok(!r.json.slots.find((s) => s.id === segC.id).blocked, '删除组后重算：C 恢复可启动（单件预算充足）');
  r = await call('DELETE', `/api/groups/${grpId}`, { version: v });
  ok(r.status === 404, '重复删除返回 404');

  console.log('# 23. 同一时段多件组内作品逐件计入');
  r = await call('POST', '/api/artworks', { version: v, name: '联展甲', limit: 1000000, existing: 0 });
  v = r.json.version;
  const artA = r.json.artworks.at(-1).id;
  r = await call('POST', '/api/artworks', { version: v, name: '联展乙', limit: 1000000, existing: 0 });
  v = r.json.version;
  const artB = r.json.artworks.at(-1).id;
  r = await call('POST', '/api/groups', { version: v, name: '联展共用额度', limit: 10000, memberIds: [artA, artB] });
  v = r.json.version;
  const duoGrp = r.json.groups.find((g) => g.name === '联展共用额度').id;
  // 同一时段联展两件：60 分钟 × 100 = 6000/件 → 组需求 12000 > 10000，整批拒绝
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'duo', hall: '七号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 100, artworkIds: [artA, artB] },
  ]});
  ok(r.status === 422 && r.json.groupExceeded?.[0]?.batchNeed === 12000
     && r.json.groupExceeded?.[0]?.overflow === 2000,
     '同一时段两件组内作品逐件计入（需求 6000×2=12000，超 2000）');
  // 缩短为 40 分钟：4000/件 → 组需求 8000 ≤ 10000，保存成功且组预占按两件计
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'duo', hall: '七号厅', start: '2026-12-01T10:00', end: '2026-12-01T10:40', lux: 100, artworkIds: [artA, artB] },
  ]});
  ok(r.status === 200, '缩短后整批保存成功');
  v = r.json.version;
  const duo = r.json.groups.find((g) => g.id === duoGrp);
  ok(duo.reservedScheduled === 8000 && duo.balance === 2000, `组预占逐件计入（${duo.reservedScheduled} = 4000×2）`);
  // 清理：清空排期 → 删组 → 删作品
  r = await call('POST', '/api/schedule', { version: v, slots: [] });
  v = r.json.version;
  r = await call('DELETE', `/api/groups/${duoGrp}`, { version: v });
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${artA}`, { version: v });
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${artB}`, { version: v });
  ok(r.status === 200, '联展测试数据已清理');

  console.log('# 24. 计划外曝光记录：演示数据与已用量口径');
  st = await getState();
  v = st.version;
  ok(Array.isArray(st.exposureRecords) && st.exposureRecords.length === 2
     && st.exposureRecords.some((x) => x.status === 'voided')
     && st.exposureRecords.find((x) => x.status === 'active').events.length === 1,
     '演示数据自带计划外曝光记录（1 条有效带更正历史 + 1 条已作废）');
  const w3rec = st.artworks.find((a) => a.id === 3);
  ok(w3rec.unplanned === 17100 && w3rec.used === 47100,
     `有效记录计入作品已用量（计划外 ${w3rec.unplanned}，已用 ${w3rec.used}，作废不计入）`);

  console.log('# 25. 录入校验：区间正时长 / 分段衔接覆盖 / 非负照度 / 作品存在 / 版本');
  r = await call('POST', '/api/artworks', { version: v, name: '计划外测试品', limit: 10000, existing: 0 });
  ok(r.status === 200, '计划外测试作品已创建（上限 10000）');
  const recArt = r.json.artworks.at(-1).id;
  v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'rs1', hall: '八号厅', start: '2027-01-10T10:00', end: '2027-01-10T11:00', lux: 100, artworkIds: [recArt] },
  ]});
  ok(r.status === 200, '测试时段 S1 已排期（60 分 × 100 = 6000）');
  v = r.json.version;
  const rs1 = r.json.slots.find((s) => s.hall === '八号厅');
  ok(!rs1.blocked, '录入记录前 S1 可启动');

  const mkRec = (over) => ({ version: v, artworkId: recArt, start: '2027-01-05T09:00', end: '2027-01-05T10:00', ...over });
  r = await call('POST', '/api/exposure-records', mkRec({
    start: '2027-01-05T09:00', end: '2027-01-05T09:00',
    segments: [{ start: '2027-01-05T09:00', end: '2027-01-05T09:00', lux: 100 }],
  }));
  ok(r.status === 422, '零时长区间被拒绝（区间须为正时长）');
  r = await call('POST', '/api/exposure-records', mkRec({ segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T09:30', lux: 100 },
    { start: '2027-01-05T09:40', end: '2027-01-05T10:00', lux: 100 },
  ]}));
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '分段有缺口被拒绝');
  r = await call('POST', '/api/exposure-records', mkRec({ segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: -1 },
  ]}));
  ok(r.status === 422, '分段负照度被拒绝');
  r = await call('POST', '/api/exposure-records', mkRec({ artworkId: 999999, segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 100 },
  ]}));
  ok(r.status === 422, '作品不存在被拒绝');
  r = await call('POST', '/api/exposure-records', mkRec({ version: 1, segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 100 },
  ]}));
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
     '过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.exposureRecords.filter((x) => x.artworkId === recArt).length === 0,
     '校验失败不改变记录、预算与版本');

  console.log('# 26. 录入成功：计入已用、余额可为负、后续时段按顺序重算阻断');
  r = await call('POST', '/api/exposure-records', mkRec({ segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T09:30', lux: 100 },
    { start: '2027-01-05T09:30', end: '2027-01-05T10:00', lux: 200 },
  ]}));
  ok(r.status === 200 && r.json.record.exposure === 9000 && r.json.record.minutes === 60
     && r.json.record.segmentCount === 2 && r.json.record.status === 'active',
     `记录已归档（曝光 ${r.json.record?.exposure} = 30×100 + 30×200）`);
  v = r.json.version;
  const rec1 = r.json.record;
  const recArtNow = r.json.artworks.find((a) => a.id === recArt);
  ok(recArtNow.used === 9000 && recArtNow.unplanned === 9000
     && recArtNow.balance === -5000 && recArtNow.over === true,
     `历史实耗使余额为负（已用 ${recArtNow.used}，余额 ${recArtNow.balance}）`);
  const rs1b = r.json.slots.find((s) => s.id === rs1.id);
  ok(rs1b.blocked && rs1b.blockedReason.gaps[0].has === 1000
     && rs1b.blockedReason.gaps[0].need === 6000 && rs1b.blockedReason.gaps[0].gap === 5000,
     'S1 按现有顺序重算为不可启动并给出缺口（has 1000 / need 6000 / gap 5000）');
  ok(r.json.blockedAfterRecord.some((s) => s.id === rs1.id), '响应携带受影响的不可启动时段');
  r = await call('POST', `/api/slots/${rs1.id}/start`);
  ok(r.status === 422 && r.json.error.code === 'BLOCKED', '缺口时段禁止启动');

  console.log('# 27. 重叠：记录 vs 时段 / 记录 vs 记录 / 排期不得覆盖有效记录');
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArt,
    start: '2027-01-10T10:30', end: '2027-01-10T11:30',
    segments: [{ start: '2027-01-10T10:30', end: '2027-01-10T11:30', lux: 50 }] });
  ok(r.status === 422 && r.json.error.code === 'OVERLAP_CONFLICT'
     && r.json.conflicts[0].kind === 'slot' && r.json.conflicts[0].slot.id === rs1.id,
     '与已有时段重叠被拒，指出时段与区间');
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArt,
    start: '2027-01-05T09:30', end: '2027-01-05T10:30',
    segments: [{ start: '2027-01-05T09:30', end: '2027-01-05T10:30', lux: 50 }] });
  ok(r.status === 422 && r.json.conflicts[0].kind === 'record' && r.json.conflicts[0].record.id === rec1.id,
     '与其他有效记录重叠被拒，指出记录与区间');
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'cover', hall: '八号厅', start: '2027-01-05T08:00', end: '2027-01-05T12:00', lux: 10, artworkIds: [recArt] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-record'
     && r.json.conflicts[0].slotB.cid === `record#${rec1.id}`,
     '后续排期不得覆盖有效记录（整批拒绝并指出记录）');
  st = await getState();
  ok(st.version === v && st.exposureRecords.filter((x) => x.artworkId === recArt).length === 1,
     '冲突失败不改变记录与版本');

  console.log('# 28. 记录更正：理由必填 / 沿用原区间 / 替换语义 / 同步重算');
  const recCorrectPath = `/api/exposure-records/${rec1.id}/correct`;
  r = await call('POST', recCorrectPath, { version: v, segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 50 },
  ]});
  ok(r.status === 422, '无理由更正被拒绝');
  r = await call('POST', recCorrectPath, { version: v, reason: 'x', segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T09:30', lux: 50 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '更正分段未覆盖原区间被拒绝');
  r = await call('POST', recCorrectPath, { version: 1, reason: 'x', segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 50 },
  ]});
  ok(r.status === 409 && r.json.state.version === v, '更正过期版本返回 409 与最新预算');
  r = await call('POST', recCorrectPath, { version: v, reason: '照度计复核：全程实际 50 lux', segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 50 },
  ]});
  ok(r.status === 200 && r.json.recordEvent.action === 'correct'
     && r.json.recordEvent.before.exposure === 9000 && r.json.recordEvent.after.exposure === 3000
     && r.json.record.exposure === 3000 && r.json.record.start === '2027-01-05T09:00',
     '更正成功：9000→3000，沿用原区间');
  v = r.json.version;
  ok(r.json.artworks.find((a) => a.id === recArt).used === 3000, '新总量替换旧总量（已用 3000，不重复累计）');
  ok(!r.json.slots.find((s) => s.id === rs1.id).blocked, '更正后缺口消除，S1 恢复可启动');
  st = await getState();
  const rec1Dto = st.exposureRecords.find((x) => x.id === rec1.id);
  ok(rec1Dto.events.length === 1 && rec1Dto.events[0].reason.includes('照度计复核')
     && rec1Dto.events[0].before.segments.length === 2 && rec1Dto.events[0].after.segments.length === 1,
     '变动历史保留前后值与理由（只增不改）');

  console.log('# 29. 记录作废：带理由、同步重算、作废后不再参与重叠校验');
  const recVoidPath = `/api/exposure-records/${rec1.id}/void`;
  r = await call('POST', recVoidPath, { version: v });
  ok(r.status === 422, '无理由作废被拒绝');
  r = await call('POST', recVoidPath, { version: v, reason: '复核为其他作品的记录，录入对象错误' });
  ok(r.status === 200 && r.json.record.status === 'voided' && r.json.recordEvent.action === 'void'
     && r.json.recordEvent.before.status === 'active' && r.json.recordEvent.after.status === 'voided',
     '作废成功并记录状态前后值');
  v = r.json.version;
  ok(r.json.artworks.find((a) => a.id === recArt).used === 0, '作废后已用量同步重算为 0');
  r = await call('POST', recCorrectPath, { version: v, reason: 'x', segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 50 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'RECORD_VOIDED', '已作废记录不可再更正');
  r = await call('POST', recVoidPath, { version: v, reason: 'x' });
  ok(r.status === 422 && r.json.error.code === 'RECORD_VOIDED', '重复作废被拒绝');
  st = await getState();
  ok(st.version === v, '失败操作不改变版本与记录');
  r = await call('POST', '/api/exposure-records', mkRec({ segments: [
    { start: '2027-01-05T09:00', end: '2027-01-05T10:00', lux: 80 },
  ]}));
  ok(r.status === 200 && r.json.record.exposure === 4800,
     '作废记录不参与重叠校验：同区间可重新归档（4800）');
  v = r.json.version;

  console.log('# 30. 计划外曝光计入额度组已用量；有记录的作品不可删除');
  r = await call('POST', '/api/groups', { version: v, name: '计划外测试组', limit: 20000, memberIds: [recArt] });
  ok(r.status === 200, '测试额度组已创建（上限 20000）');
  v = r.json.version;
  const gRec = r.json.groups.find((g) => g.name === '计划外测试组');
  ok(gRec.used === 4800 && gRec.unplanned === 4800 && gRec.reservedScheduled === 6000
     && gRec.balance === 9200,
     `组已用含有效计划外曝光（已用 ${gRec.used} / 预占 ${gRec.reserved} / 余额 ${gRec.balance}）`);
  r = await call('POST', '/api/artworks', { version: v, name: '记录删除测试品', limit: 100000, existing: 0 });
  v = r.json.version;
  const delArt = r.json.artworks.at(-1).id;
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: delArt,
    start: '2027-02-01T09:00', end: '2027-02-01T09:30',
    segments: [{ start: '2027-02-01T09:00', end: '2027-02-01T09:30', lux: 10 }] });
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${delArt}`, { version: v });
  ok(r.status === 409 && r.json.error.code === 'IN_USE', '有计划外曝光记录的作品不可删除（归档保留）');

  console.log('# 31. 滚动 24h 上限：配置（空值不限 / 非负校验）与整批超限拒绝');
  st = await getState();
  v = st.version;
  // 演示作品 #3 自带滚动上限 40000（初始窗口峰值 37800，不超限）
  ok(st.artworks.find((a) => a.id === 3).rollingLimit === 40000, '作品 #3 初始滚动上限 40000');
  ok(st.artworks.find((a) => a.id === 1).rollingLimit === null, '未设置作品滚动上限为 null（不限制）');
  // 负值拒绝
  const w3now = st.artworks.find((a) => a.id === 3);
  r = await call('PUT', '/api/artworks/3', { version: v, name: w3now.name, limit: w3now.limit, rollingLimit: -5, existing: w3now.existing, note: w3now.note });
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '负滚动上限被拒绝');
  // 字符串非法值拒绝
  r = await call('PUT', '/api/artworks/3', { version: v, name: w3now.name, limit: w3now.limit, rollingLimit: 'abc', existing: w3now.existing, note: w3now.note });
  ok(r.status === 422, '非法滚动上限被拒绝');
  st = await getState();
  ok(st.version === v && st.artworks.find((a) => a.id === 3).rollingLimit === 40000, '校验失败不改版本与上限');

  // 独立作品做滚动整批校验（避免与既有数据耦合）
  r = await call('POST', '/api/artworks', { version: v, name: '滚动测试品', limit: 1000000, rollingLimit: 20000, existing: 0 });
  ok(r.status === 200, '滚动测试作品已创建（滚动上限 20000）');
  const rollArt = r.json.artworks.at(-1).id;
  v = r.json.version;
  // 两段各 60 分钟 × 200 = 12000，间隔 23 小时：可同入一个 24h 窗口 → 峰值 24000 > 20000，整批拒绝
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'r1', hall: '甲厅', start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: 200, artworkIds: [rollArt] },
    { cid: 'r2', hall: '乙厅', start: '2027-03-02T09:00', end: '2027-03-02T10:00', lux: 200, artworkIds: [rollArt] },
  ]});
  const re1 = r.json.rollingExceeded?.[0];
  ok(r.status === 422 && r.json.error.code === 'BATCH_REJECTED' && re1 && re1.artworkId === rollArt
     && re1.rollingLimit === 20000 && re1.peakWindowExposure === 24000 && re1.peakOverflow === 4000
     && Array.isArray(re1.batchSlots) && re1.batchSlots.length === 2,
     `间隔 23h 的两段同窗超限整批拒绝（峰值 ${re1?.peakWindowExposure}，超额 ${re1?.peakOverflow}）`);
  st = await getState();
  ok(st.version === v, '滚动超限拒绝后版本不变');
  // 间隔 24 小时以上（第二段 11:00 开始，与第一段间隔 25h）→ 任意窗口不能同时完整包含，峰值 12000 ≤ 20000
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'r1', hall: '甲厅', start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: 200, artworkIds: [rollArt] },
    { cid: 'r2', hall: '乙厅', start: '2027-03-02T11:00', end: '2027-03-02T12:00', lux: 200, artworkIds: [rollArt] },
  ]});
  ok(r.status === 200 && !r.json.rollingExceeded, '间隔超过 24h：滚动校验通过、整批保存');
  v = r.json.version;

  console.log('# 32. 滚动窗口按重合分钟拆分：边界时段部分计入，最早超限窗口与超额量');
  // 单段 25h 匀速：任意 24h 窗口最多含 1440 分钟。10 lux × 1440 = 14400 ≤ 20000 通过
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'long', hall: '丙厅', start: '2027-03-05T00:00', end: '2027-03-06T01:00', lux: 10, artworkIds: [rollArt] },
  ]});
  ok(r.status === 200, '25 小时 × 10 lux（窗口峰值 14400 ≤ 20000）通过');
  v = r.json.version;
  // 20 lux × 1440 = 28800 > 20000 → 拒绝；候选参与的最早窗口在开始前一天线性递增处：
  // w=2027-03-04T16:41 起窗口内含该段 1001 分钟 = 20020（首个越限整数分钟窗口）
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'long', hall: '丙厅', start: '2027-03-05T00:00', end: '2027-03-06T01:00', lux: 20, artworkIds: [rollArt] },
  ]});
  const re2 = r.json.rollingExceeded?.[0];
  ok(r.status === 422 && re2 && re2.windowStart === '2027-03-04T16:41'
     && re2.windowExposure === 20020 && re2.overflow === 20
     && re2.peakWindowStart === '2027-03-05T00:00' && re2.peakWindowExposure === 28800
     && re2.peakOverflow === 8800,
     `长时段最早超限窗口在线性段内（${re2?.windowStart}，累计 ${re2?.windowExposure}，超额 ${re2?.overflow}），峰值 28800`);
  st = await getState();
  ok(st.version === v, '拒绝不改版本');
  // 两段（各 200 lux）：a 03-01 10:00–11:00、b 03-02 09:00–11:00。
  // w=03-01 09:41 起窗口完整含 a（60 分）+ b 头 41 分 = 101 分×200 = 20200（首个越限）；
  // 峰值窗口完整含 b（120 分×200=24000）。
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'a', hall: '甲厅', start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: 200, artworkIds: [rollArt] },
    { cid: 'b', hall: '乙厅', start: '2027-03-02T09:00', end: '2027-03-02T11:00', lux: 200, artworkIds: [rollArt] },
  ]});
  const re3 = r.json.rollingExceeded?.[0];
  ok(r.status === 422 && re3 && re3.windowStart === '2027-03-01T09:41'
     && re3.windowExposure === 20200 && re3.overflow === 200
     && re3.peakWindowExposure === 24000 && re3.peakOverflow === 4000
     && re3.batchSlots.some((x) => x.cid === 'a' && x.overlapMinutes === 60 && x.overlapExposure === 12000)
     && re3.batchSlots.some((x) => x.cid === 'b' && x.overlapMinutes === 41 && x.overlapExposure === 8200),
     `边界按重合分钟拆分：最早窗口 ${re3?.windowStart} 累计 ${re3?.windowExposure}，本批各段重合贡献正确（峰值 ${re3?.peakWindowExposure}）`);

  console.log('# 33. 下调滚动上限 → 未开始时段滚动缺口与启动阻断；被阻断时段不占后续额度');
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'k1', hall: '甲厅', start: '2027-04-01T10:00', end: '2027-04-01T12:00', lux: 100, artworkIds: [rollArt] }, // 12000
    { cid: 'k2', hall: '乙厅', start: '2027-04-02T11:00', end: '2027-04-02T12:00', lux: 100, artworkIds: [rollArt] }, // 6000，间隔 25h
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked), '上限 20000：两段均可启动');
  v = r.json.version;
  const k1 = r.json.slots.find((s) => s.plannedStart.startsWith('2027-04-01T10'));
  const k2 = r.json.slots.find((s) => s.plannedStart.startsWith('2027-04-02T11'));
  // 下调到 10000：k1 自身 12000 即超 → 阻断；k2 与 k1 间隔 25h 不可能同窗，且 k1 阻断不占额度 → k2 仍可启动
  r = await call('PUT', `/api/artworks/${rollArt}`, { version: v, name: '滚动测试品', limit: 1000000, rollingLimit: 10000, existing: 0 });
  ok(r.status === 200, '滚动上限下调到 10000');
  v = r.json.version;
  const k1b = r.json.slots.find((s) => s.id === k1.id);
  const k2b = r.json.slots.find((s) => s.id === k2.id);
  const rg1 = k1b.blockedReason.rollingGaps?.[0];
  ok(k1b.blocked && rg1 && rg1.cap === 10000 && rg1.windowExposure === 12000 && rg1.gap === 2000
     && rg1.windowStart === '2027-04-01T10:00',
     `k1 滚动缺口阻断（窗口 ${rg1?.windowStart}，累计 ${rg1?.windowExposure}，缺口 ${rg1?.gap}）`);
  ok(!k2b.blocked, 'k2 与 k1 相隔 >24h 且被阻断时段不占滚动额度：k2 仍可启动');
  r = await call('POST', `/api/slots/${k1.id}/start`);
  ok(r.status === 422 && r.json.error.code === 'BLOCKED' && r.json.blockedReason.rollingGaps?.[0]?.gap === 2000,
     '滚动缺口时段禁止启动');
  r = await call('POST', `/api/slots/${k2.id}/start`);
  ok(r.status === 200, 'k2 可正常启动（被阻断的 k1 不占后续滚动额度）');
  v = r.json.version;

  console.log('# 34. 结算造成的历史滚动超限保留事实，仅阻断后续未开始时段');
  // k2 已启动（2027-04-02 11:00–12:00 冻结 6000）。再排 k3（04-03 11:30–12:30, 100 lux = 6000），
  // 与 k2 相隔 23h30m，冻结照度下同窗峰值不超限。
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'k3', hall: '丙厅', start: '2027-04-03T11:30', end: '2027-04-03T12:30', lux: 100, artworkIds: [rollArt] },
  ]});
  ok(r.status === 200, 'k3 已排入未开始排期');
  v = r.json.version;
  const k3 = r.json.slots.find((s) => s.plannedStart.startsWith('2027-04-03'));
  ok(!k3.blocked, 'k3 结算前可启动');
  // 结算 k2 实际照度 400 → 24000（替换冻结 6000）。
  // k3 参与的最早窗口 w=04-02 11:31：含已结算 k2 尾段 29 分×400=11600 + k3 头 1 分×100=100 → 11700 > 10000。
  r = await call('POST', `/api/slots/${k2.id}/settle`, { version: v, actualStart: '2027-04-02T11:00', actualEnd: '2027-04-02T12:00', segments: [
    { start: '2027-04-02T11:00', end: '2027-04-02T12:00', lux: 400 },
  ]});
  ok(r.status === 200 && r.json.justFinishedExposure === 24000, 'k2 结算为实际 24000（替换冻结 6000）');
  v = r.json.version;
  const k3b = r.json.blockedAfterFinish.find((s) => s.id === k3.id);
  const rg3 = k3b?.blockedReason?.rollingGaps?.[0];
  ok(!!k3b && rg3 && rg3.windowStart === '2027-04-02T11:31' && rg3.windowExposure === 11700 && rg3.gap === 1700
     && rg3.windowBaseline === 11600 && rg3.need === 100,
     `历史结算超限保留，k3 被滚动缺口阻断（窗口 ${rg3?.windowStart}，基线 ${rg3?.windowBaseline} + 本时段 ${rg3?.need} = ${rg3?.windowExposure}，缺口 ${rg3?.gap}）`);
  // 已结束的 k2 状态与实际曝光保留
  st = await getState();
  ok(st.slots.find((s) => s.id === k2.id).status === 'finished'
     && st.slots.find((s) => s.id === k2.id).actualExposure === 24000,
     '历史结算事实与已结束状态保留');

  console.log('# 35. 清空滚动上限后缺口解除；多段照度计划外记录参与滚动基线');
  r = await call('PUT', `/api/artworks/${rollArt}`, { version: v, name: '滚动测试品', limit: 1000000, rollingLimit: null, existing: 0 });
  ok(r.status === 200 && r.json.artworks.find((a) => a.id === rollArt).rollingLimit === null, '清空滚动上限（null）');
  v = r.json.version;
  ok(r.json.slots.find((s) => s.id === k3.id) && !r.json.slots.find((s) => s.id === k3.id).blocked, '清空后 k3 滚动阻断解除');

  // 独立作品：滚动上限 17000，先排 04-05 09:00–10:00 100 lux = 6000
  r = await call('POST', '/api/artworks', { version: v, name: '滚动记录测试品', limit: 1000000, rollingLimit: 17000, existing: 0 });
  ok(r.status === 200, '滚动记录测试作品已创建（滚动上限 17000）');
  const rollArt2 = r.json.artworks.at(-1).id;
  v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'q', hall: '丁厅', start: '2027-04-05T09:00', end: '2027-04-05T10:00', lux: 100, artworkIds: [rollArt2] },
  ]});
  ok(r.status === 200 && !r.json.slots.find((s) => s.plannedStart.startsWith('2027-04-05')).blocked, 'q 时段（6000）可启动');
  v = r.json.version;
  const qId = r.json.slots.find((s) => s.plannedStart.startsWith('2027-04-05')).id;
  // 有效计划外记录（多段，与时段不重叠但可同入一个 24h 窗口）：
  // 04-04 09:30–10:00 200 lux = 6000 + 10:00–11:00 150 lux = 9000 → 共 15000
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: rollArt2,
    start: '2027-04-04T09:30', end: '2027-04-04T11:00',
    segments: [
      { start: '2027-04-04T09:30', end: '2027-04-04T10:00', lux: 200 },
      { start: '2027-04-04T10:00', end: '2027-04-04T11:00', lux: 150 },
    ] });
  // 峰值窗口 w=04-04 09:30：完整含记录 15000 + q 头 30 分×100=3000 → 18000 > 17000（缺口 1000）
  const rgRec = r.json.blockedAfterRecord.find((s) => s.id === qId)?.blockedReason?.rollingGaps?.[0];
  ok(r.status === 200 && rgRec && rgRec.windowStart === '2027-04-04T09:30'
     && rgRec.windowExposure === 18000 && rgRec.windowBaseline === 15000
     && rgRec.need === 3000 && rgRec.gap === 1000,
     `有效计划外多段记录并入滚动基线致 q 阻断（峰值窗口 ${rgRec?.windowStart}：${rgRec?.windowBaseline} + ${rgRec?.need} = ${rgRec?.windowExposure}，缺口 ${rgRec?.gap}）`);
  const rollRecId = r.json.record.id;
  v = r.json.version;
  // 作废记录后滚动阻断重算解除
  r = await call('POST', `/api/exposure-records/${rollRecId}/void`, { version: v, reason: '滚动测试清理：记录误登' });
  ok(r.status === 200 && !r.json.slots.find((s) => s.id === qId).blocked, '作废计划外记录后滚动缺口重算解除');
  v = r.json.version;

  console.log('# 36. 滚动配置与排期提交沿用版本校验：过期 409 且失败不改版本');
  r = await call('PUT', `/api/artworks/${rollArt2}`, { version: 1, name: '滚动记录测试品', limit: 1000000, rollingLimit: 1, existing: 0 });
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
     '作品滚动配置过期版本返回 409 与最新预算');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'z', hall: '戊厅', start: '2027-05-01T10:00', end: '2027-05-02T10:00', lux: 100, artworkIds: [rollArt2] },
  ]});
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
     '排期滚动校验过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.artworks.find((a) => a.id === rollArt2).rollingLimit === 17000, '失败不改版本与上限');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

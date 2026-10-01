'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lightbudget.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 全局版本：任何对作品 / 排期 / 时段生命周期的变更都会使其 +1。
-- 并发调整必须携带当前版本，过期则拒绝（409）。
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1
);

-- 作品：展期曝光上限（lux·min）与既有累计量
-- rolling_limit：可选的滚动 24 小时曝光上限（lux·min）；NULL 表示不限制
CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0),
  rolling_limit REAL CHECK (rolling_limit IS NULL OR rolling_limit >= 0),
  existing_amount REAL NOT NULL CHECK (existing_amount >= 0),
  note TEXT NOT NULL DEFAULT ''
);

-- 展厅时段
-- status: scheduled 未开始 / running 进行中(冻结原排期) / finished 已结束(以实际值结算)
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hall TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- 编号（按开始时间排序的顺序号）
  status TEXT NOT NULL DEFAULT 'scheduled',
  -- 排期（计划）值：开始后冻结
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  planned_lux REAL NOT NULL CHECK (planned_lux >= 0),
  -- 结束时补记的实际值
  actual_start TEXT,
  actual_end TEXT,
  actual_lux REAL,                       -- 单一照度结算的照度；分段结算为 NULL（以 actual_segments 为准）
  actual_exposure REAL,
  -- 多段照度结算：JSON 数组 [{start,end,lux,minutes,exposure}]，首尾衔接完整覆盖实际区间
  actual_segments TEXT NOT NULL DEFAULT '[]',
  -- 核算结果：该时段按当前预算是否可启动
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT '{}'
);

-- 已结束时段的分段更正记录（只增不改：每次更正写一条）
CREATE TABLE IF NOT EXISTS slot_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  seq_no INTEGER NOT NULL,              -- 该时段第几次更正（从 1 开始）
  before_start TEXT, before_end TEXT,   -- 更正前实际起止
  before_lux REAL,                      -- 更正前单一照度（分段时为 NULL）
  before_minutes INTEGER,
  before_exposure REAL,
  before_segments TEXT NOT NULL DEFAULT '[]',
  after_start TEXT NOT NULL,
  after_end TEXT NOT NULL,
  after_lux REAL,
  after_minutes INTEGER NOT NULL,
  after_exposure REAL NOT NULL,
  after_segments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- 时段 <-> 作品（一个时段可同时展出多件作品，同照度下分别计入各作品）
CREATE TABLE IF NOT EXISTS slot_artworks (
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  PRIMARY KEY (slot_id, artwork_id)
);

-- 计划外曝光记录：布展 / 搬运等排期外受光的归档记录（一件作品 + 实际起止 + 连续照度分段）
-- status: active 有效（计入已用量、参与重叠校验）/ voided 已作废（保留归档，不再计入）
CREATE TABLE IF NOT EXISTS exposure_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,             -- 实际区间开始（归档后不再改变，更正沿用原区间）
  end_time TEXT NOT NULL,               -- 实际区间结束（须为正时长）
  lux REAL,                             -- 单段照度；多段为 NULL（以 segments 为准）
  minutes INTEGER NOT NULL,
  exposure REAL NOT NULL,
  segments TEXT NOT NULL DEFAULT '[]',  -- JSON [{start,end,lux,minutes,exposure}]，首尾衔接完整覆盖区间
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- 计划外曝光记录的变动历史（只增不改）：每次更正分段 / 作废写一条，保留前后值与理由
CREATE TABLE IF NOT EXISTS exposure_record_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES exposure_records(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,              -- 该记录第几次变动（从 1 开始）
  action TEXT NOT NULL,                 -- correct 更正分段 / void 作废
  reason TEXT NOT NULL,
  before_status TEXT NOT NULL,
  before_lux REAL,
  before_minutes INTEGER,
  before_exposure REAL,
  before_segments TEXT NOT NULL DEFAULT '[]',
  after_status TEXT NOT NULL,
  after_lux REAL,
  after_minutes INTEGER,
  after_exposure REAL,
  after_segments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- 曝光额度组：巡展中易损作品共用一笔曝光额度（名称 + 非负上限）
CREATE TABLE IF NOT EXISTS quota_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0)
);

-- 额度组成员：每件作品至多归属一组（artwork_id 唯一索引保证）
CREATE TABLE IF NOT EXISTS quota_group_members (
  group_id INTEGER NOT NULL REFERENCES quota_groups(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, artwork_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_group_members_artwork ON quota_group_members(artwork_id);
`;

// 旧库升级：为已存在的表补齐新列
const MIGRATIONS = [
  `ALTER TABLE slots ADD COLUMN actual_segments TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE artworks ADD COLUMN rolling_limit REAL`,
];

function openDb() {
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    if (sql.startsWith('ALTER TABLE slots')) {
      const hasCol = db.prepare("PRAGMA table_info(slots)").all()
        .some((c) => c.name === 'actual_segments');
      if (!hasCol) db.exec(sql);
    } else if (sql.startsWith('ALTER TABLE artworks')) {
      const hasCol = db.prepare("PRAGMA table_info(artworks)").all()
        .some((c) => c.name === 'rolling_limit');
      if (!hasCol) db.exec(sql);
    }
  }
  return db;
}

function resetDb() {
  if (DB_PATH !== ':memory:' && fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
      const f = DB_PATH + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }
  const db = openDb();
  db.close();
  return DB_PATH;
}

module.exports = { openDb, resetDb, DB_PATH };

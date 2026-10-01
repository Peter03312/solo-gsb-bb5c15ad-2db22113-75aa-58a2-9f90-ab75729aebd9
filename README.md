# 巡展作品光照预算 Web 工作台

为巡展作品管理展期曝光预算的本地 Web 工具：Node.js + SQLite + 浏览器页面，单机本地运行。

- **作品维度**：录入展期曝光上限与既有累计量，实时显示已用 / 预占 / 余额（单位 lux·min）；另可为每件作品设置**可选的滚动 24 小时曝光上限**（空值不限制，非空须非负），任意连续 24 小时窗口超限将拒绝整批排期、阻断相关未开始时段启动。
- **滚动 24 小时曝光上限**：对任意连续 24 小时窗口，按分钟精度累计窗口内各时段对该作品的曝光——**已结束取实际分段、进行中取冻结计划、未开始取计划、有效计划外记录取归档分段**；跨窗口边界的分段按重合分钟拆分，同一作品逐条相加。整批排期仅校验**本批未开始时段参与**的窗口，超限则整批拒绝并指出作品、最早超限窗口与超额量。结算 / 更正 / 计划外记录 / 下调上限造成的历史超限都**保留事实与进行中状态**，只按现有时序重算未开始时段的滚动缺口与启动阻断；作废后同样重算，已阻断时段不占后续滚动额度。
- **额度组维度**：巡展中易损作品可共用一笔曝光额度。策展人维护组的名称、非负上限与成员（每件作品至多归属一组）；组已用 = 成员既有累计 + 已结束时段实际曝光，预占 = 成员进行中（冻结）+ 未开始计划曝光，同一时段有多件组内作品时逐件计入。
- **时段维度**：为展厅时段录入起止时间、照度（lux）和展出作品，按 **实际经过分钟 × 照度** 计算曝光。
- **多段照度**：巡展现场实际照度可能随时间变化。进行中时段可按**实际起止 + 多段照度**结算，每段含起止与非负照度，曝光 = Σ（段内实际分钟 × 照度）；分段必须按时间顺序首尾衔接、无重叠且完整覆盖实际区间，否则**整批拒绝**。
- **整批排期**：未开始时段在草稿中统一编辑后整批提交；同一作品时段重叠、或“已用 + 预占”超上限（**单件上限与组上限须同时满足**）时 **拒绝整批**，逐条指出冲突作品与时段；组超限时指出组、各成员贡献与超额量。
- **生命周期**：时段开始即冻结原排期并保留预占；结束时补记实际起止与照度（单一或多段），**实际曝光替换该时段预占**；结算超量后按开始时间/编号顺序标出不可启动时段与缺口并禁止启动。
- **结算更正**：已结束时段可凭理由提交**完整分段更正**（起止沿用原实际区间），系统记录更正前后的曝光、时间与分段；**新总量替换旧总量，不重复累计**，并同步重算作品已用量、后续时段不可启动状态与缺口；更正历史只增不改。
- **组配置调整**：结算、更正或调整组配置后，按现有时序重算余额与不可启动时段；组上限调低到已用量以下时仍保留历史及进行中状态，仅阻止后续启动并展示缺口。
- **计划外曝光**：布展 / 搬运时作品可能在排期外受光。工作人员选一件作品，录入**实际起止 + 连续照度分段**并归档，可查看本次曝光与全部归档记录；区间须为正时长，分段首尾衔接、完整覆盖且照度非负。记录不得与该作品已有时段或其他有效记录重叠，后续排期也不得覆盖有效记录，冲突会指出对象与区间。已归档记录只能**带理由更正分段（沿用原区间）或作废**，每次变动保留前后值与理由；有效曝光计入作品及所属额度组的已用量（允许历史实耗使余额为负），录入 / 更正 / 作废后均按现有顺序重算未开始时段的缺口与启动阻断。
- **乐观并发**：所有调整（含多段结算、更正、组配置与计划外曝光记录）携带当前版本号，过期版本返回 409 与最新预算，失败不改变结算与版本。

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动后打开：

- **页面地址**：http://localhost:8080
- 初始化：首次启动自动建表并写入演示数据（3 件作品 + 已结束/进行中/未开始时段 + 1 个额度组 + 2 条计划外曝光记录）。

如需更换宿主机端口：

```bash
PORT=9090 docker compose up -d --build   # 页面变为 http://localhost:9090
```

停止与重置初始数据：

```bash
docker compose down            # 停止，数据保留在命名卷中
docker compose down -v         # 同时删除数据卷，下次启动重新初始化
```

## 本地直接运行（需要 Node.js ≥ 20）

```bash
npm install
npm start
# 打开 http://localhost:8080
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本地直跑可设 `127.0.0.1`） |
| `DB_PATH` | `./data/lightbudget.db`（Docker 内为 `/app/data/lightbudget.db`） | SQLite 数据库文件路径；文件不存在时自动建库并初始化 |

## 计算与校验规则

- **曝光量** = （结束 − 开始，分钟）× 照度 lux，单位 **lux·min**。
- **多段结算曝光量** = Σ各段（段结束 − 段开始，分钟）× 该段照度；每段照度须为非负数。
- **分段完整性**（多段结算 / 更正共用）：
  1. 每段时间格式合法、结束晚于开始、照度非负；
  2. 分段按时间顺序排列，第 *n* 段开始必须等于第 *n−1* 段结束（首尾衔接、无缺口、无重叠）；
  3. 首段开始 = 实际区间开始、末段结束 = 实际区间结束（完整覆盖）。
  
  任一条不满足返回 `422 SEGMENTS_INVALID`，`segmentErrors` 逐条说明，整批不落库。
- **已用** = 作品既有累计量 + 所有已结束时段的**实际**曝光（多段结算取分段求和值；更正后为最新总量，旧值不保留在累计中）+ **有效计划外曝光记录**的曝光。
- **预占** = 进行中时段的（冻结）计划曝光 + 所有未开始时段的计划曝光之和。
- **余额** = 上限 − 已用 − 预占；余额为负即超量。
- **额度组**：
  - 组有名称（唯一）、非负上限与成员列表；**每件作品至多归属一组**，重复或不存在的成员一律拒绝；
  - **组已用** = 各成员（既有累计 + 已结束时段实际曝光 + 有效计划外曝光）之和；**组预占** = 各成员（进行中冻结计划 + 未开始计划曝光）之和；
  - **同一时段有多件组内作品时逐件计入**：该时段曝光按组内成员数重复累计（与单件口径一致）；
  - 组上限允许调低到已用量以下：历史（已结束）与进行中状态保留不变，仅后续未开始时段被阻止启动，组余额显示为负缺口。
- 排期整批保存时校验：
  1. 时间格式合法、结束晚于开始、照度/累计量非负（无效时序或负值一律拒绝）；
  2. 同一作品在任意两个未开始时段、以及与进行中（冻结区间）/已结束（实际区间）时段之间不得重叠；
  3. 未开始时段不得覆盖该作品的**有效计划外曝光记录**区间（冲突按 `new-record` 指出记录与区间）；
  4. 每件作品「既有 + 有效计划外曝光 + 已结束实际 + 进行中预占 + 本批未开始预占」不得超过展期上限；
  5. 每个额度组「组已用 + 进行中预占 + 本批未开始预占（逐件计入）」不得超过组上限。
- 任一条不满足则整批不落库，响应中给出作品、冲突时段对或超量数值；组超限时给出组、各成员贡献与超额量。
- **结算更正规则**：
  - 仅 `finished` 时段可更正；更正必须带 `reason`（1–500 字）；
  - 更正分段的实际起止**沿用该时段原实际起止**（更正只调整照度分段，不改变展出区间）；
  - 每次更正写一条 `slot_corrections` 记录：理由、更正前后起止/照度/分钟数/曝光/完整分段、时间戳与序号（只增不改）；
  - 新总量**替换**旧总量（不重复累计），随后重算作品已用量、未开始时段不可启动标记与缺口；
  - 更正同样需要携带当前版本，过期返回 409 与最新预算。
- **计划外曝光记录规则**：
  - 一条记录对应**一件作品**：`{artworkId, start, end, segments}`；区间须为正时长，分段规则与多段结算相同（衔接、覆盖、非负，不满足返回 `422 SEGMENTS_INVALID`）；
  - **重叠约束**：同一作品的记录不得与已有时段（未开始/进行中按计划区间、已结束按实际区间）或其他**有效**记录重叠（`422 OVERLAP_CONFLICT`，`conflicts` 逐条指出对象与区间）；后续整批排期也不得覆盖有效记录；
  - **已用量**：有效记录曝光计入作品及所属额度组的已用量；属于历史实耗，**允许使余额为负**，随后按现有顺序重算未开始时段的缺口与启动阻断；
  - **归档记录只能更正或作废**：更正必须带理由、分段沿用原区间（`POST /api/exposure-records/:id/correct`）；作废必须带理由（`POST /api/exposure-records/:id/void`）；每次变动写一条 `exposure_record_events`（前后状态/照度/分钟数/曝光/完整分段 + 理由 + 时间戳，只增不改）；作废后不再计入已用量、不参与重叠校验，且不可再更正或再次作废；
  - 更正 / 作废同样同步重算已用量、缺口与启动阻断；有计划外记录的作品不可删除（归档保留）；
  - 三个接口均携带 `version`，过期返回 409 与最新预算；校验失败不改变记录、预算与版本。
- **不可启动核算**：每次调整/启动/结算/更正/组配置变更后，未开始时段按开始时间（再按编号）顺序尝试占用预算；任一关联作品余额不足、或所属额度组余额不足、或滚动 24 小时窗口超该作品上限，即标记为“不可启动”并列出每件作品 / 每个组的可用余额、需求与缺口（滚动缺口给出超额量最大的超限窗口、窗口累计与超额量），启动接口对该时段返回 422。调整排期保存后自动重新核算。
- **滚动 24 小时曝光上限**（作品级，可选）：
  - 字段 `dailyLimit`：`null`（或缺省 / 空串）表示**不限制**；非空必须为**非负数**，单位 lux·min；
  - 对任意连续 24 小时窗口 `[t, t+1440 分钟)` 累计该作品曝光：已结束时段取**实际分段**、进行中时段取**冻结的原计划**、未开始时段取**计划**、有效（未作废）计划外记录取**归档分段**；
  - **跨窗口边界按重合分钟拆分**（窗口内分钟数 × 该分段照度），同一作品的各时段 / 记录逐条相加；多段照度的每一段独立拆分；
  - **整批排期**除单件展期上限与额度组规则外，只校验“**本批未开始时段参与**（至少重合 1 分钟）”的窗口；超限返回 `422 BATCH_REJECTED`，在 `rollingExceeded` 中逐作品给出**最早超限窗口**（起止）、窗口内累计 `windowExposure` 与超额量 `overflow`，整批不落库；
  - 结算（`finish` / `settle`）、已结束时段更正、计划外记录录入 / 更正 / 作废、以及**下调 `dailyLimit`** 之后，历史（已结束）与进行中状态一律保留，按现有时序重算未开始时段的滚动缺口与启动阻断；历史实耗造成的窗口超限不会回滚，只阻止后续启动；
  - 不可启动时段（含因滚动缺口被阻断）**不占用后续滚动额度**：核算按时序逐段尝试，被跳过的时段不进入后续窗口累计；
  - 配置与排期提交同样携带 `version`，过期返回 409 与最新预算，校验失败不推进版本。
- **并发版本**：每次成功变更版本号 +1。请求必须携带当前 `version`；不匹配时返回 `409 VERSION_STALE` 与最新完整预算，前端自动刷新后需重新调整提交。**校验失败不会推进版本、不改变任何结算数据。**

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 最新版本、作品预算汇总、**额度组预算汇总（`groups`）**、全部时段（含 `actualSegments` 与 `corrections` 更正历史）、**计划外曝光记录（`exposureRecords`）**及不可启动核算结果 |
| POST | `/api/artworks` | 录入作品（body 带 `version`；可带 `dailyLimit` 滚动 24h 上限，`null`/缺省不限制） |
| PUT | `/api/artworks/:id` | 修改作品展期上限 / **滚动 24h 上限（`dailyLimit`）** / 既有量等（整字段提交，下调滚动上限仅阻断后续） |
| DELETE | `/api/artworks/:id` | 删除作品（被时段引用、属于额度组或有计划外曝光记录时拒绝） |
| POST | `/api/groups` | **新建额度组**：`{version, name, limit, memberIds:[作品id...]}` |
| PUT | `/api/groups/:id` | **修改额度组**名称/上限/成员（整组替换成员列表） |
| DELETE | `/api/groups/:id` | **删除额度组**（成员作品与历史记录保留） |
| POST | `/api/schedule` | **整批替换未开始时段**（body：`{version, slots:[...]}`；单件与组上限同时校验，且不得覆盖有效计划外记录） |
| POST | `/api/slots/:id/start` | 启动时段：冻结原排期、保留预占 |
| POST | `/api/slots/:id/finish` | 结束补记（单一照度，兼容语义不变）：`{actualStart, actualEnd, actualLux}`，实际曝光替换预占并重新核算 |
| POST | `/api/slots/:id/settle` | **多段照度结算（进行中时段）**：`{version, actualStart, actualEnd, segments:[{start,end,lux}]}` |
| POST | `/api/slots/:id/correct` | **已结束时段完整分段更正**：`{version, reason, segments:[{start,end,lux}]}`，起止须完整覆盖原实际区间 |
| POST | `/api/exposure-records` | **录入计划外曝光**：`{version, artworkId, start, end, segments:[{start,end,lux}]}` |
| POST | `/api/exposure-records/:id/correct` | **计划外记录分段更正**：`{version, reason, segments:[...]}`，沿用原区间 |
| POST | `/api/exposure-records/:id/void` | **作废计划外记录**：`{version, reason}` |

`GET /api/state` 中额度组（`groups`）的字段：

- `id` / `name` / `limit`：组编号、名称、组上限；
- `members`：`[{id, name}]` 成员作品；
- `used` / `reserved`（含 `reservedRunning` / `reservedScheduled`）/ `committed` / `balance` / `over`：
  与作品同口径的组级汇总（成员求和，同一时段多件组内作品逐件计入）。

时段 `blockedReason` 在原有 `gaps`（单件缺口）之外新增 `groupGaps`（组缺口）：
`[{groupId, groupName, has, need, gap, memberCount}]`，其中 `need` 已按组内成员数逐件计入。

滚动 24 小时缺口新增 `rollingGaps`：
`[{artworkId, artworkName, dailyLimit, windowStart, windowEnd, total, overflow}]`，
表示该作品在窗口 `windowStart ~ windowEnd`（连续 24 小时）内累计 `total` lux·min，
超过滚动上限 `dailyLimit` 达 `overflow` lux·min（取超额量最大的窗口）。

作品汇总新增 `dailyLimit` 字段：滚动 24 小时曝光上限（lux·min），`null` 表示不限制。

整批排期被滚动上限拒绝时，错误响应新增 `rollingExceeded`（逐作品给出**最早**超限窗口）：
`[{artworkId, artworkName, dailyLimit, windowStart, windowEnd, windowExposure, overflow}]`；
可与 `budgetExceeded` / `groupExceeded` 同时出现，均为整批拒绝且不推进版本。

`GET /api/state` 中已结束时段的字段：

- `actualStart` / `actualEnd` / `actualMinutes` / `actualExposure`：实际区间与总量；
- `actualLux`：仅单段时为该段照度，多段时为 `null`；
- `actualSegments`：`[{start,end,lux,minutes,exposure}, ...]` 完整分段；
- `corrections`：更正历史数组，每条含 `seqNo`、`reason`、`createdAt` 与 `before`/`after`（各自含 `start,end,lux,minutes,exposure,segments`）。

`GET /api/state` 中计划外曝光记录（`exposureRecords`）的字段：

- `id` / `artworkId` / `artworkName`：记录编号与所属作品；
- `start` / `end` / `minutes` / `exposure`：实际区间、时长与曝光总量；
- `lux`：仅单段时为该段照度，多段时为 `null`；`segments` / `segmentCount`：完整分段；
- `status`：`active` 有效（计入已用量）/ `voided` 已作废（保留归档，不计入）；
- `createdAt`：录入时间；
- `events`：变动历史数组，每条含 `seqNo`、`action`（`correct` / `void`）、`reason`、`createdAt`
  与 `before`/`after`（各自含 `status,lux,minutes,exposure,segments`）。

作品与额度组汇总新增 `unplanned` 字段：有效计划外曝光计入已用量的部分（组为成员之和）。
录入 / 更正 / 作废的响应在完整预算之外附带：`record`（本次记录）、`recordEvent`（本次变动，更正/作废时）
与 `blockedAfterRecord`（重算后不可启动的未开始时段及缺口）。

## HTTP 调用示例（多段结算 / 更正）

以下示例使用初始演示数据（`http://localhost:8080`）。先取当前版本：

```bash
curl -s http://localhost:8080/api/state            # 读取 "version"
```

### 1. 多段照度结算（进行中时段 → 已结束）

把进行中的时段 #2（计划 2026-09-30 09:00–13:00）按三段实测照度结算：
09:00–11:00 为 180 lux（120 分）、11:00–12:30 为 240 lux（90 分）、12:30–13:00 闭灯为 0 lux（30 分）。
曝光 = 120×180 + 90×240 + 30×0 = 43200 lux·min。

```bash
curl -s -X POST http://localhost:8080/api/slots/2/settle \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "actualStart": "2026-09-30T09:00",
    "actualEnd":   "2026-09-30T13:00",
    "segments": [
      {"start": "2026-09-30T09:00", "end": "2026-09-30T11:00", "lux": 180},
      {"start": "2026-09-30T11:00", "end": "2026-09-30T12:30", "lux": 240},
      {"start": "2026-09-30T12:30", "end": "2026-09-30T13:00", "lux": 0}
    ]
  }'
```

成功返回完整最新预算（与 `/api/state` 同构），并附带：

```json
{
  "version": 2,
  "justFinishedExposure": 43200,
  "justFinishedMinutes": 240,
  "justFinishedSegments": [ {"start": "...", "end": "...", "lux": 180, "minutes": 120, "exposure": 21600}, "..."],
  "settlement": { "actualStart": "...", "actualEnd": "...", "actualMinutes": 240, "actualExposure": 43200, "segments": ["..."] },
  "blockedAfterFinish": [ {"id": 3, "blockedReason": {"gaps": ["..."]}} ]
}
```

分段有缺口 / 重叠 / 未覆盖 / 负照度时：

```json
HTTP 422
{ "error": {"code": "SEGMENTS_INVALID", "message": "分段结算已拒绝：..."},
  "segmentErrors": ["第 2 段开始 2026-09-30T11:10 必须与第 1 段结束 2026-09-30T11:00 首尾衔接（无重叠、无缺口）"] }
```

### 2. 已结束时段分段更正

对已结束的时段 #1 提交带理由的完整分段更正（起止沿用原实际区间 09:10–11:50）：

```bash
curl -s -X POST http://localhost:8080/api/slots/1/correct \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 2,
    "reason": "照度计复核：布光阶段 100 lux，巡场调亮后 170 lux",
    "segments": [
      {"start": "2026-09-29T09:10", "end": "2026-09-29T10:30", "lux": 100},
      {"start": "2026-09-29T10:30", "end": "2026-09-29T11:50", "lux": 170}
    ]
  }'
```

返回最新预算与本次更正记录（`correction.before/after` 含更正前后曝光、分钟数与完整分段），
时段的 `corrections` 历史追加一条；作品已用量、后续时段 `blocked` 与缺口已按新总量重算。

错误情况：

- 分段未完整覆盖原实际区间 / 衔接失败 / 负照度 → `422 SEGMENTS_INVALID`（`segmentErrors` 逐条说明）；
- 缺少理由 → `422 VALIDATION`；
- 时段不是 `finished` → `422 NOT_FINISHED`；
- 版本过期 → `409 VERSION_STALE`，响应带 `state`（最新完整预算）；用其中的 `version` 重试即可。

### 3. 单一照度结算（原接口，语义不变）

```bash
curl -s -X POST http://localhost:8080/api/slots/2/finish \
  -H 'Content-Type: application/json' \
  -d '{"actualStart": "2026-09-30T09:00", "actualEnd": "2026-09-30T13:00", "actualLux": 300}'
```

> `finish` 仍为原有无版本、单照度结算与返回语义（`justFinishedExposure`、`blockedAfterFinish`）；
> 内部以单段形式保存，因此该时段之后同样可以用 `/correct` 做多段更正。

## HTTP 调用示例（计划外曝光记录）

以下示例使用初始演示数据（`http://localhost:8080`）。演示数据自带两条《青铜纹样》摄影（作品 #3）的
计划外记录：**#1 有效**（2026-09-28 15:00–16:30，两段共 17100 lux·min，带一次更正历史）与
**#2 已作废**。先取当前版本：

```bash
curl -s http://localhost:8080/api/state            # 读取 "version" 与 "exposureRecords"
```

### 1. 录入计划外曝光（一件作品 + 实际起止 + 连续照度分段）

布展时《青铜纹样》摄影在排期外受光：09:00–09:40 为 250 lux（40 分）、09:40–10:00 为 60 lux（20 分），
曝光 = 40×250 + 20×60 = 11200 lux·min。

```bash
curl -s -X POST http://localhost:8080/api/exposure-records \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "artworkId": 3,
    "start": "2026-09-28T09:00",
    "end":   "2026-09-28T10:00",
    "segments": [
      {"start": "2026-09-28T09:00", "end": "2026-09-28T09:40", "lux": 250},
      {"start": "2026-09-28T09:40", "end": "2026-09-28T10:00", "lux": 60}
    ]
  }'
```

成功返回完整最新预算，并附带 `record`（本次归档记录）与 `blockedAfterRecord`（重算后不可启动的
未开始时段及缺口）。有效曝光立即计入作品与所属额度组的 `used` / `unplanned`；属于历史实耗，
**允许余额为负**。

错误情况：

- 区间零/负时长、分段缺口 / 重叠 / 未覆盖 / 负照度 → `422 SEGMENTS_INVALID`（`segmentErrors` 逐条说明）；
- 与该作品已有时段或其他有效记录重叠 → `422 OVERLAP_CONFLICT`，`conflicts` 指出对象与区间：

```json
HTTP 422
{ "error": {"code": "OVERLAP_CONFLICT", "message": "计划外曝光记录与已有时段或其他有效记录重叠"},
  "conflicts": [
    {"artworkId": 3, "artworkName": "《青铜纹样》摄影", "kind": "slot",
     "slot": {"id": 4, "hall": "二号厅", "status": "scheduled",
              "start": "2026-10-02T10:00", "end": "2026-10-02T13:00"},
     "label": "未开始时段（计划区间） #4 二号厅 2026-10-02T10:00 ~ 2026-10-02T13:00"},
    {"artworkId": 3, "artworkName": "《青铜纹样》摄影", "kind": "record",
     "record": {"id": 1, "start": "2026-09-28T15:00", "end": "2026-09-28T16:30"},
     "label": "计划外曝光记录 #1 2026-09-28T15:00 ~ 2026-09-28T16:30（有效）"}
  ]
}
```

- 版本过期 → `409 VERSION_STALE`，响应带 `state`（最新完整预算）。

> 反向约束同样生效：整批排期（`POST /api/schedule`）中任一时段覆盖有效记录区间时整批拒绝，
> 冲突项 `kind` 为 `new-record`，`slotB` 给出被覆盖的记录与区间。

### 2. 更正分段（沿用原区间，带理由）

```bash
curl -s -X POST http://localhost:8080/api/exposure-records/3/correct \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 2,
    "reason": "照度计复核：布展全程实际为 140 lux",
    "segments": [
      {"start": "2026-09-28T09:00", "end": "2026-09-28T10:00", "lux": 140}
    ]
  }'
```

返回 `record`（更正后）、`recordEvent`（本次变动：`before/after` 各含状态、照度、分钟数、曝光与完整分段）
与最新预算；新总量**替换**旧总量（11200 → 8400），作品 / 额度组已用量与未开始时段阻断同步重算。
分段必须完整覆盖**原区间**（09:00–10:00），否则 `422 SEGMENTS_INVALID`；缺理由 `422 VALIDATION`。

### 3. 作废记录（带理由，归档保留）

```bash
curl -s -X POST http://localhost:8080/api/exposure-records/3/void \
  -H 'Content-Type: application/json' \
  -d '{"version": 3, "reason": "复核为其他作品的记录，录入对象错误"}'
```

作废后记录保留在 `exposureRecords`（`status: "voided"`），不再计入已用量、不参与重叠校验
（同区间可重新归档），且不可再更正或再次作废（`422 RECORD_VOIDED`）；已用量、缺口与启动阻断同步重算。

## HTTP 调用示例（曝光额度组）

以下示例基于初始演示数据（`http://localhost:8080`）：演示组 **#1「纸本联展共用额度」**（上限 300000，
成员为《山水轴》《星夜手稿》）。所有组配置接口与作品接口一样携带 `version`，
过期返回 `409 VERSION_STALE` 与最新预算；校验失败不改版本与任何记录。

### 1. 新建额度组

```bash
curl -s -X POST http://localhost:8080/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"version": 1, "name": "摄影联展共用额度", "limit": 80000, "memberIds": [3]}'
```

- `memberIds` 中**重复、不存在、或已归属其他组**的作品都会返回 `422 VALIDATION`（每件作品至多归属一组；
  例如演示数据中作品 1、2 已属组 #1，直接再入其他组会被拒绝）；
- 成功返回完整最新预算，`groups` 数组中包含新组的 `used / reserved / committed / balance` 聚合值。

### 2. 修改组配置（名称 / 上限 / 成员）

```bash
curl -s -X PUT http://localhost:8080/api/groups/1 \
  -H 'Content-Type: application/json' \
  -d '{"version": 2, "name": "纸本联展共用额度", "limit": 150000, "memberIds": [1, 2]}'
```

- 上限允许调低到当前已用量以下：历史（已结束）与进行中状态保留，仅后续未开始时段被阻止启动；
  响应中该组 `balance` 为负（缺口），受影响时段的 `blockedReason.groupGaps` 给出组缺口，例如：

```json
{ "groupId": 1, "groupName": "纸本联展共用额度", "has": -400, "need": 21600, "gap": 22000, "memberCount": 1 }
```

### 3. 整批排期的组上限校验

整批保存未开始排期时，**单件上限与组上限须同时满足**。下面的批次单件预算充足，
但两件组内作品同批排期使组预占超限（同一时段多件组内作品逐件计入），整批拒绝：

```bash
curl -s -X POST http://localhost:8080/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"version": 3, "slots": [
        {"cid": "duo", "hall": "四号厅", "start": "2026-10-05T10:00", "end": "2026-10-05T11:00",
         "lux": 100, "artworkIds": [1, 2]}
      ]}'
```

```json
HTTP 422
{ "error": {"code": "BATCH_REJECTED", "message": "整批已拒绝：有作品或额度组预占后将超过上限"},
  "groupExceeded": [{
    "groupId": 1, "groupName": "纸本联展共用额度", "limit": 150000,
    "used": 150400, "batchNeed": 12000, "projected": 162400, "overflow": 12400,
    "members": [
      {"artworkId": 1, "artworkName": "《山水轴》纸本水墨", "contribution": 88400},
      {"artworkId": 2, "artworkName": "《星夜手稿》水彩", "contribution": 74000}
    ]
  }]
}
```

> `used` = 成员既有累计 + 已结束实际 + 进行中预占；`batchNeed` = 本批新增预占（同一时段两件成员计 6000×2）；
> `members[].contribution` 为各成员对 `projected` 的贡献，合计即 `projected`。
> 单件超限时仍返回原有的 `budgetExceeded`，两者可同时出现。

### 4. 删除额度组

```bash
curl -s -X DELETE http://localhost:8080/api/groups/1 \
  -H 'Content-Type: application/json' -d '{"version": 3}'
```

> 上一步整批拒绝不会推进版本，因此此处仍为 `version: 3`。

删除后成员作品与全部历史记录保留，余额与不可启动时段按现有时序重算。

## HTTP 调用示例（滚动 24 小时曝光上限）

### 1. 为作品设置滚动上限（空值 = 不限制）

`POST /api/artworks` / `PUT /api/artworks/:id` 的 body 增加可选字段 `dailyLimit`：

```bash
# 先取版本
curl -s http://localhost:8080/api/state            # 读取 "version"

# 新建作品并设置滚动 24h 上限 50000 lux·min
curl -s -X POST http://localhost:8080/api/artworks \
  -H 'Content-Type: application/json' \
  -d '{"version": 1, "name": "《日曝限》绢本", "limit": 1000000, "existing": 0,
       "dailyLimit": 50000}'

# 取消限制：传 null（或空串 / 省略）
curl -s -X PUT http://localhost:8080/api/artworks/4 \
  -H 'Content-Type: application/json' \
  -d '{"version": 3, "name": "《日曝限》绢本", "limit": 1000000, "existing": 0,
       "dailyLimit": null}'
```

- `dailyLimit` 为负数 / 非数值 → `422 VALIDATION`；`null`（或缺省）表示不限制；
- 作品汇总（`GET /api/state` 的 `artworks[]`）新增 `dailyLimit` 字段；
- 过期版本同样返回 `409 VERSION_STALE` 与最新预算，失败不改版本。

### 2. 整批排期：滚动窗口超限整批拒绝

设作品 #4 的 `dailyLimit = 50000`。本批两条时段：

- A：`2027-02-28 10:00–14:00`，200 lux → 240×200 = 48000；
- B：`2027-03-01 09:00–10:00`，200 lux → 60×200 = 12000。

两者相距 23 小时，存在共同的连续 24h 窗口。最早超限窗口为
`02-28 09:11 ~ 03-01 09:11`：A 全部 48000 + B 进入窗口的第 1 分钟 200 = **50200**，超 **200**。

```bash
curl -s -X POST http://localhost:8080/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"version": 2, "slots": [
        {"cid": "ra", "hall": "甲厅", "start": "2027-02-28T10:00", "end": "2027-02-28T14:00",
         "lux": 200, "artworkIds": [4]},
        {"cid": "rb", "hall": "乙厅", "start": "2027-03-01T09:00", "end": "2027-03-01T10:00",
         "lux": 200, "artworkIds": [4]}
      ]}'
```

```json
HTTP 422
{ "error": {"code": "BATCH_REJECTED", "message": "整批已拒绝：……（含滚动 24 小时曝光上限）"},
  "budgetExceeded": [],
  "groupExceeded": [],
  "rollingExceeded": [
    {"artworkId": 4, "artworkName": "《日曝限》绢本", "dailyLimit": 50000,
     "windowStart": "2027-02-28T09:11", "windowEnd": "2027-03-01T09:11",
     "windowExposure": 50200, "overflow": 200}
  ]}
```

被拒后版本不变；把 B 改到 `2027-03-02 09:00`（与 A 相距超过 24h、无共同窗口）即可保存。

### 3. 下调上限 / 结算 / 更正 / 作废：历史保留，只阻断后续

将 `dailyLimit` 下调到某条未开始时段自身窗口实占以下（例如 40000 < 48000），保存成功后该时段被标记
`blocked`，`blockedReason.rollingGaps` 给出超限窗口与超额量；已结束事实与进行中状态不变：

```json
{ "gaps": [], "groupGaps": [],
  "rollingGaps": [
    {"artworkId": 4, "artworkName": "《日曝限》绢本", "dailyLimit": 40000,
     "windowStart": "2027-02-27T14:00", "windowEnd": "2027-02-28T14:00",
     "total": 48000, "overflow": 8000}
  ]}
```

对该时段调用启动接口返回 `422 BLOCKED`（携带同一 `blockedReason`）。
已结束时段按更高实际照度结算、或对已结束时段 / 有效计划外记录做分段更正后，系统按现有时序重算：
历史窗口超限保留为事实，仅把受影响的后续未开始时段标记为不可启动；把记录作废、或更正回低照度、
或上调 / 清空 `dailyLimit` 后，滚动缺口重新计算、被错峰的时段恢复可启动。

## 页面用法

- **滚动 24 小时上限**：作品弹窗新增「滚动 24 小时上限（lux·min，留空不限制）」，作品表新增同名列（留空显示「不限」）。整批保存因滚动窗口超限被拒时，Toast 逐条列出作品、最早超限窗口与超额量；未开始时段因滚动缺口被标记「不可启动」时，行下缺口明细同时列出展期缺口、组缺口与**滚动窗口缺口**（窗口起止、窗口累计、超额量），启动拦截 Toast 也会展示。
- **计划外曝光记录**：「计划外曝光记录」卡片列出全部归档记录（作品、实际起止、照度、时长、曝光、状态、
  录入时间）。点击 **＋ 录入计划外曝光** 选择一件作品、填写实际起止并逐段录入连续照度（单段时可随区间
  自动带出起止），弹窗实时显示各段时长/曝光与总量；点击 **分段/变动** 展开分段明细与历次变动
  （更正/作废的理由与前后值）；有效记录可 **分段更正**（沿用原区间、预填当前分段、理由必填）或
  **作废**（理由必填）。作品表与额度组表的「已用」列在含计划外曝光时标注「含计划外 …」，
  录入/更正/作废后页面同步刷新受影响预算与不可启动时段。
- **额度组**：「曝光额度组」卡片展示各组成员、上限、已用 / 预占 / 余额；点击 **＋ 新建额度组** 或行内 **编辑**
  可维护名称、上限与成员（已归属其他组的作品在成员列表中禁用）；**删除** 仅解除共用额度，作品与历史保留。
  作品表新增「额度组」列标识每件作品所属组。
- **阻断原因**：未开始排期中被标记「不可启动」的行下方列出缺口明细——既包括单件作品缺口，
  也包括额度组缺口（组可用余额、本时段需求与缺口）；启动被拦截时 Toast 同样展示。
- **结束进行中时段**：在「进行中 / 已结束时段」点击 **结束补记**，弹窗内可切换
  「单一照度结算 / 多段照度结算」；多段模式下逐段填写起止与照度，弹窗实时显示各段时长/曝光与总量，
  提交时服务端再次校验衔接与覆盖。
- **查看分段与更正历史**：已结束时段点击 **分段/更正** 展开，展示实际照度分段与历次更正
  （理由、更正前后曝光与时间）。
- **更正已结束时段**：点击 **分段更正**，弹窗预填当前分段并显示原实际区间与更正前曝光，
  调整分段、填写理由后提交；成功后页面刷新作品已用量、缺口与不可启动标记。

## 快速体验超量拦截

初始演示数据以 2026-09-30 为当天，预算均充足。进入页面：

1. 对「一号厅 09:00–13:00（进行中）」点 **结束补记**；
2. 把实际照度改为 `300`（240 分钟 × 300 = 72000 lux·min），保存；
3. 后续二号厅时段会被标记为 **不可启动**，页面列出《山水轴》《星夜手稿》的缺口，启动按钮被禁止；
4. 在未开始排期草稿中缩短时长 / 降低照度 / 改展作品后 **整批校验并保存**，缺口消除即可重新启动。

体验**组维度阻断**：把演示组「纸本联展共用额度」上限改为 `150000`（低于当前组已用+预占 199000），
保存后组余额显示负缺口，两件纸本作品的后续未开始时段即因组缺口被禁止启动；
将上限调回或调整排期后恢复。

体验**计划外曝光**：「计划外曝光记录」中演示记录 #1（《青铜纹样》布展受光 17100 lux·min）已计入该作品已用。
点击 **＋ 录入计划外曝光**，为《青铜纹样》录入一段与时段 #4（2026-10-02 10:00–13:00）重叠的区间，
会被拒绝并指出冲突时段；改为排期外区间即可归档——例如 2026-09-28 18:00–19:00、照度 800 lux
（48000 lux·min），归档后《青铜纹样》余额转负，时段 #4 因缺口被标记不可启动；
再对该记录 **分段更正**（调低照度）或 **作废**，已用量与缺口同步重算、#4 恢复可启动，
变动历史在 **分段/变动** 中可查。

体验**滚动 24 小时上限**：编辑任意作品（如《青铜纹样》摄影），把「滚动 24 小时上限」填为 `20000`
保存——与进行中 / 未开始时段或有效计划外记录有共同 24h 窗口的未开始时段会立即被标记不可启动，
缺口明细给出最早超限窗口与超额量；整批保存新排期时若本批时段参与的窗口超限则整批拒绝（Toast 列出
作品、最早窗口、超额量）。把上限清空（恢复不限制）后，相关时段重新核算恢复可启动。

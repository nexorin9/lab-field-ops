# 检验业务现场作业系统

> 检验工程师在仪器报警或写处理记录时 ⌘K 一键拉出仪器档案 + 报警码 SOP + 最近校准三页同屏；
> 写回的处置记录经人工确认后由队列异步推到 LIS 通道；信息科工程师在终端里注册厂商插件并实时看队列重试与红色告警。

检验工程师日常面对几百条厂家型号、各式报警码、各类校准记录——找不到现行 SOP、处理记录凭记忆写、回头对不上 LIS 报告。
本系统把「仪器 / 报警码 / 校准 / 处理记录 / 审计」五类对象做成可 ⌘K 命令面板的索引，把现场处置单页化为 SplitView 三屏同看，
把对外通道（厂商工单 / LIS 写回 / 仪器心跳）抽象为可注册的 plugin，把写回与状态变化全部留痕。

## 适用场景 / 目标岗位

| 岗位 | 什么时候用 | 得到什么 |
|------|------------|----------|
| 检验工程师 | 仪器报警响起，需要现场定位报警码 SOP + 关联仪器档案 + 最近校准 | ⌘K 一键拉出三页同屏，SOP 粘贴厂商工单 URL 即内嵌卡片 |
| 检验工程师 | 处理完仪器异常，需要把处置记录写回 LIS 通道 | 填表 → 人工确认 → 队列异步推到 LIS 通道（追加 JSONL 文件替身），看板可见状态 |
| 检验工程师 | 编辑 SOP 文档时需要附上厂商手册 / 工单链接 | 粘贴 URL 自动识别为内嵌卡，不匹配时退化为截图占位 |
| 信息科工程师 | 新接入一台仪器 / 一个厂商接口，需要登记队列 | 终端 `lab-field-ops plugin add ./examples/manifests/iot-heartbeat.json`，队列名/版本/状态即时打印 |
| 信息科工程师 | 队列持续重试或告警，需要转人工或重投 | 看板红条 + 一键「重投 / 转人工」，事件链可审计 |
| 设备科长 | 早会要仪器在线率 / write-back 失败率 / 当日处置摘要 | DashboardPage 一屏：仪器健康网格 + 写回状态饼图 + 当日 digest |

> **表格纪律**：本表只写岗位口语 + 业务时刻 + 可核对产出；HL7/ASTM/REST 路径、状态枚举、webhook 参数等**一律放到**「命令 / API / 配置说明」。

## 能力要点

- ⌘K 索引五类对象（仪器 / 报警码 / 校准 / 插件 / 手册），支持模糊匹配与组合查询（如 `Siemens/ADVIA 2400/W002`）
- SOP 编辑器粘贴 URL 自动识别为内嵌卡（厂商工单 / LIS 报告 / 校准 JSON / 仪器手册 PDF）；不匹配退化为截图占位
- SplitView 三页同屏，刷新保留路径与比例，⌘K 命中多对象时一次性打开
- 信息科 CLI 一行注册厂商 plugin（manifest 校验 + capability 沙箱 + 自动挂队列）
- 写回队列默认 5 次指数退避（200ms → 30s），失败落审计 + 看板红条，可一键重投 / 转人工
- append-only 审计（SHA-256 hash + 触发器阻断 UPDATE/DELETE），事件可按 eventId 串联 replay
- SSRF-safe 抓取器：deny-by-default（拒绝 loopback / RFC1918 / link-local），allowlist CIDR 配置化
- 描述子热重载：新增一类厂商 URL 描述子无需重启进程，watcher 监听 data/embed-registry.json

## 快速开始

```bash
# 1. 安装依赖（pnpm ≥ 9；npm/yarn 自行替换）
pnpm install

# 2. 复制环境变量并按需修改
cp .env.example .env

# 3. 灌入脱敏样例（vendor=Siemens/Roche/Abbott 占位，assetTag 用 ASSET-LAB-{0001..0003}）
pnpm seed

# 4. 启动前端（默认 :3000，代理 /api → :4000）
pnpm dev
# 同时另起终端跑后端：
pnpm ts-node --transpile-only src/server/main.ts

# 5. 验证（开 ⌘K 试输入 Siemens/ADVIA 2400/W002，看三页同屏；或跑下方脚本一键走完）
pnpm test
bash scripts/demo.sh
```

> 单机部署也可一行：`pnpm build && pnpm start`，数据持久化到 `data/lab.db` 与 `data/lis-writeback.ndjson`。
> Docker 部署见 `docker compose up -d`（详见「命令 / API / 配置说明」）。

## 命令 / API / 配置说明

### CLI（信息科工程师入口）

| 命令 | 作用 | 示例 |
|------|------|------|
| `lab-field-ops plugin add <manifest.json>` | 注册厂商 plugin 并自动挂队列 | `lab-field-ops plugin add examples/manifests/iot-heartbeat.json` |
| `lab-field-ops plugin remove <name>` | 卸载 plugin，触发 Hook.Uninstall | `lab-field-ops plugin remove iot-heartbeat` |
| `lab-field-ops plugin list` | 列出已注册 plugin（name / version / type / queue / status） | — |
| `lab-field-ops seed` | 灌入脱敏样例（幂等） | — |

### REST API（前后端分离；前端代理 `/api`）

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/instruments` / `/api/instruments/:id` | 仪器列表 / 详情 |
| GET | `/api/alarm-codes?vendor=&model=` | 报警码联合主键查询 |
| GET | `/api/calibrations?instrumentId=` | 校准历史（按时间倒序） |
| POST | `/api/processing-records` | 写一条处置记录（confirmed 默认 false） |
| POST | `/api/processing-records/:id/confirm` | 人工确认 → 入队 write-back |
| POST | `/api/processing-records/:id/retry` | failed 状态重投 |
| GET | `/api/plugins` / DELETE | `/api/plugins/:name` | plugin 列表 / 卸载 |
| GET | `/api/audit?kind=&from=&to=` | 审计查询（分页） |
| GET | `/api/audit/:eventId/replay` | 审计事件链 replay |
| GET | `/api/queue/status` | 队列状态（attempts / lastError / status） |
| POST | `/api/queue/retry/:jobId` | 重投（仅 failed 允许） |

### 配置项（环境变量 / `.env`）

- `PORT`：后端 HTTP 端口（默认 4000）
- `DATABASE_PATH`：SQLite 文件路径（默认 `data/lab.db`）
- `EMBED_ALLOWLIST_CIDR`：SSRF 白名单（逗号分隔；留空 → deny-by-default）
- `LIS_WRITEBACK_CHANNEL`：write-back JSONL 路径（默认 `data/lis-writeback.ndjson`）
- `HEARTBEAT_RATE_LIMIT`：每 (vendor, model) 每秒最多心跳（默认 10）
- `AUTH_TOKEN`：管理 API Bearer Token（占位，强制替换）
- `EMBED_REGISTRY_PATH`：描述子热重载文件路径

### Plugin manifest（`examples/manifests/*.json`）

```json
{
  "name": "iot-heartbeat",
  "version": "1.0.0",
  "type": "task",
  "hooks": ["task"],
  "queueName": "iot-heartbeat",
  "rateLimit": 10,
  "auth": "bearer"
}
```

### 部署

提供两种方式：**单机 Node 部署**（适合医院信息科内网直接跑）与 **Docker 部署**（适合统一编排 / 与其他服务共存）。数据（SQLite + NDJSON 写回通道）通过 `./data` 与 `./logs` 持久化到宿主机，**不要把数据卷纳入镜像**。

#### 方式一：单机 Node 部署

```bash
# 1. 准备 Node ≥ 20 + pnpm ≥ 9
node --version    # 应 ≥ v20
corepack enable && corepack prepare pnpm@9.12.0 --activate

# 2. 装依赖 + 编译 + 灌样例
pnpm install --frozen-lockfile
pnpm build                       # tsc + vite build → dist/
pnpm seed                        # 灌脱敏样例（幂等）

# 3. 复制环境变量并按需修改（首次部署必须替换 AUTH_TOKEN）
cp .env.example .env
# 编辑 .env，至少替换 AUTH_TOKEN=replace-with-long-random-string 为强随机串

# 4. 后台启动（监听 :4000，REST + SPA 同一端口）
pnpm start                       # 实际跑 node dist/server/main.js

# 5. 健康检查
curl -sS http://127.0.0.1:4000/api/instruments | jq '.items | length'
# 期望：3（脱敏样例：Siemens / Roche / Abbott 三台占位仪器）

# 6. 浏览器打开 http://<host>:4000，按 ⌘K 输入 Siemens/ADVIA 2400/W002 验证三页同屏
```

日常运维：

- 升级代码：`git pull && pnpm install --frozen-lockfile && pnpm build && pnpm start`（旧进程退出后启新进程；保留 `data/` 与 `logs/` 卷）。
- 看队列状态：`curl -sS http://127.0.0.1:4000/api/queue/status | jq`（5 次重试用尽会显红）。
- 审计查询：`curl -sS 'http://127.0.0.1:4000/api/audit?kind=processing_record.state_change&from=2026-08-01' | jq`。
- 关闭：`kill <pid>` 或 `pkill -f 'node dist/server/main.js'`。

#### 方式二：Docker 部署

```bash
# 1. 构建镜像（首次约 3-5 分钟；better-sqlite3 在 deps 阶段编译）
docker build -t lab-field-ops:latest .

# 2. 启动（data/ 与 logs/ 自动挂载到宿主机同路径）
docker compose up -d

# 3. 健康检查（容器启动后等 10s，再 curl）
docker compose ps                  # 期望 STATUS=Up (healthy)
curl -sS http://127.0.0.1:4000/api/instruments | jq '.items | length'

# 4. 看日志
docker compose logs -f lab-field-ops

# 5. 浏览器打开 http://<host>:4000
```

首次 `docker compose up` 前**必须**编辑 `docker-compose.yml` 中的 `AUTH_TOKEN: "replace-with-long-random-string"`（或改为 `${AUTH_TOKEN}` 从宿主机环境变量读），否则等于放空门。**升级镜像**：`docker compose down && docker compose build --pull && docker compose up -d`（宿主机 `data/` `logs/` 不动）。

> **端口说明**：默认容器内 `PORT=4000`；如需映射到宿主机其他端口，改 `docker-compose.yml` 的 `ports` 段（如 `"8080:4000"`）。本机开发用 vite 的 `:3000` 仅 dev 模式（`pnpm dev` + 后端 `:4000`，前端代理 `/api`）；**生产部署统一 `:4000`，HTTP server 自带静态 SPA 托管**。

## 典型场景

### 场景一：⌘K 三页同屏定位报警

1. 检验工程师听到 ADVIA Centaur 报警声，按下 `⌘K`
2. 输入 `Siemens/ADVIA 2400/W002`，回车
3. SplitView 一次性打开：左 = 仪器档案页（含 SOP 编辑器 + 处理记录 + 校准历史），中 = 报警码 SOP 页，右 = 最近 5 次校准
4. 操作员在 SOP 编辑器里粘贴厂商工单 URL：`https://vendor.example.com/ticket/T-ABC123`
5. 自动识别为内嵌卡，状态 = `loading` → `loaded`；失败则显示 `error` + 重试按钮

### 场景二：写记录回写 LIS 通道

1. 操作员在仪器档案页填处置记录：根因 / 处置步骤 / 操作员
2. 点击「提交」→ 状态变 `received → parsed → verified`
3. 点击「人工确认 write-back」→ POST `/api/processing-records/:id/confirm`
4. 状态变 `verified → writeback_pending`，队列入队
5. write-back task 用 safeFetch（先 deny 内网 → 走白名单）推 LIS 通道
6. JSONL 追加一行；看板显示「写回成功」绿勾；事件落 audit_event（kind=writeback.success）

### 场景三：信息科注册厂商 plugin

1. 信息科工程师收到新厂商的 webhook 地址 + manifest
2. 终端：`lab-field-ops plugin add ./examples/manifests/lis-writeback.json`
3. CLI 校验 manifest（Zod schema + capability 白名单），写入 plugin_manifest 表
4. 自动挂队列 `lis-writeback`，写入 audit_event（kind=plugin.add）
5. 看板多一行「队列活跃 / 0 失败」

## 输出样例

（脱敏报告 / 终端输出片段；`docs/screenshots/` 占位截图说明）

### DashboardPage 截图说明

- `docs/screenshots/dashboard.png`：仪器健康网格 + 写回状态饼图 + 队列卡片 + 当日 digest
- `docs/screenshots/kbar.png`：⌘K 命令面板打开，五类对象分组
- `docs/screenshots/splitview.png`：SplitView 三屏同看（仪器档案 / 报警码 / 校准）

### 看板 JSON 样例

```json
{
  "queueStatus": [
    {"name": "lis-writeback", "concurrency": 1, "pending": 0, "failed": 0, "lastError": null},
    {"name": "iot-heartbeat", "concurrency": 1, "pending": 2, "failed": 0, "lastError": null}
  ],
  "writeback": {
    "received": 1, "parsed": 0, "verified": 1,
    "writeback_pending": 0, "written_back": 12, "failed": 0
  }
}
```

### 写回 LIS JSONL 一行样例

```json
{"recordId":"R-2026-0001","instrumentId":"ASSET-LAB-0001","accessionNo":"L2608290001","operatorId":"op-0142","rootCause":"reagent-lot","steps":["replaced reagent","ran QC"],"confirmedAt":"2026-08-29T10:15:00Z"}
```

## 架构与数据流

```
┌─────────────────┐  ⌘K   ┌─────────────────────┐
│  检验工程师 Web  │ ◀───▶ │  React + KBar SPA    │
└────────┬────────┘       │  SplitView / Pages   │
         │ /api/*          └──────────┬──────────┘
         │                           │
         ▼                           ▼
┌────────────────────────────────────────────────┐
│            REST API (server/routes)            │
│  presenters  ·  state machine  ·  audit ledger │
└────────┬───────────────────┬───────────────────┘
         │                   │
         ▼                   ▼
┌────────────────┐    ┌──────────────────────────┐
│  SQLite (WAL)  │    │  Queue (createQueue)     │
│  instruments   │    │  lis-writeback           │
│  alarm_codes   │    │  iot-heartbeat           │
│  calibrations  │    │  exponential backoff     │
│  processing_*  │    │  dedupe by event_id      │
│  plugin_*      │    └──────────┬───────────────┘
│  audit_event   │               │
└────────────────┘               ▼
                        ┌──────────────────────┐
                        │ Tasks (writeback /   │
                        │ heartbeat)           │
                        │ → safeFetch (SSRF)   │
                        │ → JSONL / webhook    │
                        └──────────────────────┘
                                  │
                                  ▼
                        ┌──────────────────────┐
                        │ PluginManager        │
                        │ hooks: api / task /  │
                        │        unfurl        │
                        └──────────────────────┘
```

主路径：仪器报警 → ⌘K → SplitView → SOP 编辑器粘贴 URL → embed 描述子匹配 → safeFetch → 内嵌卡渲染
　　→ 操作员填处置记录 → 人工 confirm → 状态机迁移 → 队列入队 → handler 推 LIS JSONL → audit_event 留痕 → 看板更新

## 安全与合规边界

- **write-back 必须经人工确认**：状态机 `received → parsed → verified → writeback_pending → written_back`，
  跳过任一阶段抛 `StateMachineError`；二次 confirm 幂等返回当前态，不重复入队
- **不直改 LIS 业务库**：本系统仅向 `LIS_WRITEBACK_CHANNEL`（替身 = 本地 NDJSON）追加推送；
  真实 LIS 对接由 HIS/集成平台消费 JSONL 后入业务库（不在本系统范围）
- **审计 append-only**：`audit_event` 表通过 SQLite 触发器阻断 UPDATE/DELETE；hash 链可按 eventId 串联 replay
- **SSRF deny-by-default**：内置拒绝 RFC1918 / loopback / link-local；公网目标必须显式 allowlist

## 项目结构

```
lab-field-ops/
├── src/
│   ├── shared/
│   │   ├── embeds/                # Embed 描述子注册表 + 适配器
│   │   └── types.ts               # 共享类型（Instrument / AlarmCode / Calibration 等）
│   ├── server/
│   │   ├── routes/                # REST API
│   │   ├── presenters/            # presenter + contracts（schema 锁字段）
│   │   ├── plugin/                # PluginManager + dispatcher + capability
│   │   ├── queue/                 # createQueue + dedupe + tasks (writeback/heartbeat)
│   │   ├── audit/                 # appendAudit + replay
│   │   ├── processing/            # ProcessingRecord 状态机
│   │   ├── utils/                 # ssrfFetch + requestFilteringAgent
│   │   ├── db.ts + migrations/    # better-sqlite3 + WAL
│   │   ├── errors.ts              # AppError 体系
│   │   └── main.ts                # listen 入口（供 e2e 启停）
│   ├── app/                       # React + KBar SPA
│   │   ├── kbar/                  # ⌘K 索引 / 模糊匹配 / 多键索引
│   │   ├── components/            # SplitView / InstrumentPage / AlarmCodePage / DashboardPage / AuditDrawer / EmbedCard
│   │   └── editor/                # SOPEditor（粘贴 URL → 嵌入卡）
│   └── cli/                       # 信息科 CLI（plugin add/remove/list/seed）
├── examples/manifests/            # 示例 plugin manifest（脱敏占位）
├── scripts/                       # demo.sh + screenshot.ts + golden fixtures
├── tests/                         # vitest 套件（unit + e2e + golden）
├── docs/screenshots/              # 截图占位
├── data/                          # SQLite + NDJSON 运行时（清理时排除）
├── logs/                          # 运行时日志（清理时排除）
├── Dockerfile + docker-compose.yml
├── package.json + tsconfig.json + vite.config.ts
└── README.md
```

## License

MIT

---

## 关注我们

欢迎扫码关注公众号，获取项目更新与交流加群：

![关注我们](qrcode.jpg)
# Lab Field Operations System

> When an instrument alarm rings or a processing record is being written, the lab engineer presses ⌘K and pulls up three pages side by side — instrument profile + alarm code SOP + recent calibration. The processing record written back is confirmed manually and then pushed asynchronously by the queue to the LIS channel. The IT engineer registers a vendor plugin in the terminal and watches queue retries and red alerts in real time.

Every day the lab engineer faces hundreds of vendor models, various alarm codes, and different types of calibration records — no place to find the current SOP, processing records written from memory, and no traceability back to the LIS report.
This system makes five types of objects (instruments / alarm codes / calibrations / processing records / audits) into a ⌘K command palette index, flattens the on-site operations to a SplitView with three screens side by side, abstracts external channels (vendor tickets / LIS write-back / instrument heartbeats) as registerable plugins, and leaves full traces for all write-backs and state changes.

## Use Cases / Target Roles

| Role | When | What You Get |
|------|------|--------------|
| Lab engineer | When an instrument alarm rings and you need to look up the alarm code SOP + instrument profile + recent calibration on site | ⌘K pulls up three pages side by side; pasting a vendor ticket URL into the SOP creates an embed card |
| Lab engineer | After handling an instrument anomaly and you need to write the processing record back to the LIS channel | Fill in the form → manual confirmation → the queue pushes asynchronously to the LIS channel (appends to a JSONL file stub) and the dashboard shows the status |
| Lab engineer | When editing an SOP document you need to attach vendor manuals / ticket links | Pasting a URL is automatically recognized as an embed card; if it does not match, it degrades to a screenshot placeholder |
| IT engineer | When onboarding a new instrument / vendor interface and need to register a queue | Run `lab-field-ops plugin add ./examples/manifests/iot-heartbeat.json` in the terminal; queue name / version / status printed instantly |
| IT engineer | When the queue keeps retrying or alerting and you need to escalate or repush | Red banner on the dashboard plus a one-click "Repush / Escalate" button; the event chain is auditable |
| Equipment department head | For a morning briefing that needs instrument online rate / write-back failure rate / daily processing digest | A single DashboardPage shows the instrument health grid + write-back status pie chart + daily digest |

> **Table discipline**: This table only lists role phrasing + business moment + verifiable output. HL7/ASTM/REST paths, state enums, webhook parameters, etc. **always go** in "Commands / API / Configuration".

## Capability Highlights

- ⌘K indexes five types of objects (instruments / alarm codes / calibrations / plugins / manuals) with fuzzy matching and combined queries (e.g. `Siemens/ADVIA 2400/W002`)
- The SOP editor auto-recognizes pasted URLs as embed cards (vendor ticket / LIS report / calibration JSON / instrument manual PDF); unmatched URLs degrade to a screenshot placeholder
- SplitView with three pages side by side preserves path and ratio on refresh; opens all matches in one go when ⌘K hits multiple objects
- IT engineer CLI registers a vendor plugin in one line (manifest validation + capability sandbox + automatic queue mounting)
- Write-back queue defaults to 5 exponential backoffs (200ms → 30s); failures fall into audit + a red banner on the dashboard; one-click repush / escalate
- Append-only audit (SHA-256 hash + trigger blocking UPDATE/DELETE); events can be chained for replay by eventId
- SSRF-safe fetcher: deny-by-default (rejects loopback / RFC1918 / link-local); allowlist CIDR is configurable
- Descriptor hot-reload: adding a new vendor URL descriptor does not require restarting the process; a watcher monitors `data/embed-registry.json`

## Quick Start

```bash
# 1. Install dependencies (pnpm ≥ 9; replace with npm/yarn as preferred)
pnpm install

# 2. Copy env variables and modify as needed
cp .env.example .env

# 3. Seed desensitized samples (vendor=Siemens/Roche/Abbott placeholders, assetTag uses ASSET-LAB-{0001..0003})
pnpm seed

# 4. Start the frontend (default :3000, proxies /api → :4000)
pnpm dev
# In another terminal, run the backend:
pnpm ts-node --transpile-only src/server/main.ts

# 5. Verify (open ⌘K and type Siemens/ADVIA 2400/W002 to see three pages side by side; or run the script below)
pnpm test
bash scripts/demo.sh
```

> Single-machine deployment can also be done in one line: `pnpm build && pnpm start`. Data persists to `data/lab.db` and `data/lis-writeback.ndjson`.
> For Docker deployment, see `docker compose up -d` (see "Commands / API / Configuration" for details).

## Commands / API / Configuration

### CLI (entry point for IT engineers)

| Command | Effect | Example |
|------|------|------|
| `lab-field-ops plugin add <manifest.json>` | Register a vendor plugin and automatically mount a queue | `lab-field-ops plugin add examples/manifests/iot-heartbeat.json` |
| `lab-field-ops plugin remove <name>` | Uninstall a plugin, triggers Hook.Uninstall | `lab-field-ops plugin remove iot-heartbeat` |
| `lab-field-ops plugin list` | List registered plugins (name / version / type / queue / status) | — |
| `lab-field-ops seed` | Seed desensitized samples (idempotent) | — |

### REST API (frontend/backend separated; frontend proxies `/api`)

| Method | Path | Effect |
|------|------|------|
| GET | `/api/instruments` / `/api/instruments/:id` | Instrument list / detail |
| GET | `/api/alarm-codes?vendor=&model=` | Alarm code composite primary key query |
| GET | `/api/calibrations?instrumentId=` | Calibration history (sorted by time descending) |
| POST | `/api/processing-records` | Create a processing record (confirmed defaults to false) |
| POST | `/api/processing-records/:id/confirm` | Manual confirmation → enqueue write-back |
| POST | `/api/processing-records/:id/retry` | Repush a failed record |
| GET | `/api/plugins` / DELETE | `/api/plugins/:name` | Plugin list / uninstall |
| GET | `/api/audit?kind=&from=&to=` | Audit query (paginated) |
| GET | `/api/audit/:eventId/replay` | Replay an audit event chain |
| GET | `/api/queue/status` | Queue status (attempts / lastError / status) |
| POST | `/api/queue/retry/:jobId` | Repush (allowed only for failed jobs) |

### Configuration (env vars / `.env`)

- `PORT`: backend HTTP port (default 4000)
- `DATABASE_PATH`: SQLite file path (default `data/lab.db`)
- `EMBED_ALLOWLIST_CIDR`: SSRF allowlist (comma-separated; empty → deny-by-default)
- `LIS_WRITEBACK_CHANNEL`: write-back JSONL path (default `data/lis-writeback.ndjson`)
- `HEARTBEAT_RATE_LIMIT`: maximum heartbeats per second per (vendor, model) (default 10)
- `AUTH_TOKEN`: management API Bearer Token (placeholder, must be replaced)
- `EMBED_REGISTRY_PATH`: descriptor hot-reload file path

### Plugin manifest (`examples/manifests/*.json`)

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

### Deployment

Two options are provided: **standalone Node deployment** (suited for running directly in the hospital intranet) and **Docker deployment** (suited for unified orchestration / coexisting with other services). Data (SQLite + NDJSON write-back channel) is persisted to the host via `./data` and `./logs`; **do not bake data volumes into the image**.

#### Option 1: Standalone Node deployment

```bash
# 1. Prepare Node ≥ 20 + pnpm ≥ 9
node --version    # should be ≥ v20
corepack enable && corepack prepare pnpm@9.12.0 --activate

# 2. Install dependencies + build + seed samples
pnpm install --frozen-lockfile
pnpm build                       # tsc + vite build → dist/
pnpm seed                        # seed desensitized samples (idempotent)

# 3. Copy env variables and modify as needed (must replace AUTH_TOKEN on first deployment)
cp .env.example .env
# Edit .env and at minimum replace AUTH_TOKEN=replace-with-long-random-string with a strong random string

# 4. Start in the background (listens on :4000, REST + SPA on the same port)
pnpm start                       # actually runs node dist/server/main.js

# 5. Health check
curl -sS http://127.0.0.1:4000/api/instruments | jq '.items | length'
# Expected: 3 (desensitized samples: Siemens / Roche / Abbott three placeholder instruments)

# 6. Open http://<host>:4000 in a browser, press ⌘K and type Siemens/ADVIA 2400/W002 to verify three pages side by side
```

Daily operations:

- Upgrade code: `git pull && pnpm install --frozen-lockfile && pnpm build && pnpm start` (start the new process after the old one exits; keep `data/` and `logs/` volumes).
- Check queue status: `curl -sS http://127.0.0.1:4000/api/queue/status | jq` (5 retries exhausted will show red).
- Audit query: `curl -sS 'http://127.0.0.1:4000/api/audit?kind=processing_record.state_change&from=2026-08-01' | jq`.
- Stop: `kill <pid>` or `pkill -f 'node dist/server/main.js'`.

#### Option 2: Docker deployment

```bash
# 1. Build the image (first time ~3-5 minutes; better-sqlite3 compiles in the deps stage)
docker build -t lab-field-ops:latest .

# 2. Start (data/ and logs/ are automatically mounted to the same path on the host)
docker compose up -d

# 3. Health check (wait 10s after container start, then curl)
docker compose ps                  # expected STATUS=Up (healthy)
curl -sS http://127.0.0.1:4000/api/instruments | jq '.items | length'

# 4. View logs
docker compose logs -f lab-field-ops

# 5. Open http://<host>:4000 in a browser
```

Before the first `docker compose up`, you **must** edit `AUTH_TOKEN: "replace-with-long-random-string"` in `docker-compose.yml` (or change to `${AUTH_TOKEN}` to read from a host environment variable); otherwise you are leaving the door open. **Upgrade the image**: `docker compose down && docker compose build --pull && docker compose up -d` (host `data/` and `logs/` are preserved).

> **Port notes**: The default `PORT=4000` inside the container. If you need to map to a different host port, modify the `ports` section in `docker-compose.yml` (e.g. `"8080:4000"`). The vite `:3000` is only for dev mode (`pnpm dev` + backend `:4000`, frontend proxies `/api`); **production deployment uses `:4000` uniformly, with the HTTP server hosting the static SPA**.

## Typical Scenarios

### Scenario 1: ⌘K locates an alarm across three pages

1. The lab engineer hears the ADVIA Centaur alarm, presses `⌘K`
2. Types `Siemens/ADVIA 2400/W002`, presses Enter
3. SplitView opens all at once: left = instrument profile page (with SOP editor + processing records + calibration history), center = alarm code SOP page, right = most recent 5 calibrations
4. The operator pastes a vendor ticket URL into the SOP editor: `https://vendor.example.com/ticket/T-ABC123`
5. Automatically recognized as an embed card; status moves `loading` → `loaded`; on failure, shows `error` + a retry button

### Scenario 2: Write a record back to the LIS channel

1. The operator fills in the processing record on the instrument profile page: root cause / handling steps / operator
2. Clicks "Submit" → status changes to `received → parsed → verified`
3. Clicks "Manual confirm write-back" → POST `/api/processing-records/:id/confirm`
4. Status changes to `verified → writeback_pending`; the record enters the queue
5. The write-back task uses safeFetch (first deny the internal network → then walk the allowlist) to push to the LIS channel
6. A new line is appended to the JSONL; the dashboard shows "Write-back successful" with a green check; the event lands in audit_event (kind=writeback.success)

### Scenario 3: IT engineer registers a vendor plugin

1. The IT engineer receives a webhook URL + manifest from a new vendor
2. Terminal: `lab-field-ops plugin add ./examples/manifests/lis-writeback.json`
3. The CLI validates the manifest (Zod schema + capability allowlist) and writes to the plugin_manifest table
4. The queue `lis-writeback` is mounted automatically; an audit_event (kind=plugin.add) is written
5. The dashboard gains a new "Queue active / 0 failed" entry

## Output Samples

(Desensitized reports / terminal output excerpts; placeholder screenshot notes under `docs/screenshots/`)

### DashboardPage screenshot notes

- `docs/screenshots/dashboard.png`: instrument health grid + write-back status pie chart + queue cards + daily digest
- `docs/screenshots/kbar.png`: ⌘K command palette open, five types of objects grouped
- `docs/screenshots/splitview.png`: SplitView with three screens side by side (instrument profile / alarm code / calibration)

### Dashboard JSON sample

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

### One-line sample written back to LIS JSONL

```json
{"recordId":"R-2026-0001","instrumentId":"ASSET-LAB-0001","accessionNo":"L2608290001","operatorId":"op-0142","rootCause":"reagent-lot","steps":["replaced reagent","ran QC"],"confirmedAt":"2026-08-29T10:15:00Z"}
```

## Architecture and Data Flow

```
┌─────────────────┐  ⌘K   ┌─────────────────────┐
│  Lab Engineer Web │ ◀───▶ │  React + KBar SPA    │
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

Main path: instrument alarm → ⌘K → SplitView → paste URL in SOP editor → embed descriptor match → safeFetch → render embed card
　　→ operator fills in the processing record → manual confirm → state machine transition → queue entry → handler pushes to LIS JSONL → audit_event traced → dashboard update

## Security and Compliance Boundaries

- **Write-back must go through manual confirmation**: state machine `received → parsed → verified → writeback_pending → written_back`;
  skipping any stage throws `StateMachineError`; a second confirm returns the current state idempotently and does not re-enqueue
- **Does not directly modify the LIS business database**: this system only appends to `LIS_WRITEBACK_CHANNEL` (stub = local NDJSON);
  real LIS integration is handled by HIS / the integration platform consuming the JSONL and writing to the business database (out of scope for this system)
- **Audit append-only**: the `audit_event` table blocks UPDATE/DELETE via SQLite triggers; hash chains can be replayed in order by eventId
- **SSRF deny-by-default**: built-in to reject RFC1918 / loopback / link-local; public targets must be explicitly allowlisted

## Project Structure

```
lab-field-ops/
├── src/
│   ├── shared/
│   │   ├── embeds/                # Embed descriptor registry + adapters
│   │   └── types.ts               # Shared types (Instrument / AlarmCode / Calibration etc.)
│   ├── server/
│   │   ├── routes/                # REST API
│   │   ├── presenters/            # presenter + contracts (schema-locked fields)
│   │   ├── plugin/                # PluginManager + dispatcher + capability
│   │   ├── queue/                 # createQueue + dedupe + tasks (writeback/heartbeat)
│   │   ├── audit/                 # appendAudit + replay
│   │   ├── processing/            # ProcessingRecord state machine
│   │   ├── utils/                 # ssrfFetch + requestFilteringAgent
│   │   ├── db.ts + migrations/    # better-sqlite3 + WAL
│   │   ├── errors.ts              # AppError system
│   │   └── main.ts                # listen entry (for e2e start/stop)
│   ├── app/                       # React + KBar SPA
│   │   ├── kbar/                  # ⌘K index / fuzzy matching / multi-key index
│   │   ├── components/            # SplitView / InstrumentPage / AlarmCodePage / DashboardPage / AuditDrawer / EmbedCard
│   │   └── editor/                # SOPEditor (paste URL → embed card)
│   └── cli/                       # IT engineer CLI (plugin add/remove/list/seed)
├── examples/manifests/            # Sample plugin manifests (desensitized placeholders)
├── scripts/                       # demo.sh + screenshot.ts + golden fixtures
├── tests/                         # vitest suites (unit + e2e + golden)
├── docs/screenshots/              # Screenshot placeholders
├── data/                          # SQLite + NDJSON runtime (excluded at cleanup)
├── logs/                          # Runtime logs (excluded at cleanup)
├── Dockerfile + docker-compose.yml
├── package.json + tsconfig.json + vite.config.ts
└── README.md
```

## License

MIT

---

## Follow Us

Scan the QR code to follow our official account for updates and community access:

![Follow Us](qrcode.jpg)
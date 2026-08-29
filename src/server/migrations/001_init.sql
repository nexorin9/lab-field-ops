-- src/server/migrations/001_init.sql
-- 初始 schema：仪器、报警码联合主键、校准、处理记录、plugin manifest、append-only audit_event。

CREATE TABLE IF NOT EXISTS instrument (
  instrument_id   TEXT PRIMARY KEY,
  vendor          TEXT NOT NULL,
  model           TEXT NOT NULL,
  asset_tag       TEXT NOT NULL,
  location        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('online', 'offline', 'alarm')),
  installed_at    TEXT NOT NULL,
  last_seen_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_instrument_vendor_model ON instrument (vendor, model);

-- 报警码：联合主键 (vendor, model, alarm_code)
CREATE TABLE IF NOT EXISTS alarm_code (
  vendor        TEXT NOT NULL,
  model         TEXT NOT NULL,
  alarm_code    TEXT NOT NULL,
  alarm_label   TEXT NOT NULL,
  sop_md        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (vendor, model, alarm_code)
);

-- 校准记录
CREATE TABLE IF NOT EXISTS calibration (
  calibration_id  TEXT PRIMARY KEY,
  instrument_id   TEXT NOT NULL REFERENCES instrument(instrument_id),
  calibrated_at   TEXT NOT NULL,
  payload_json    TEXT NOT NULL,    -- JSON 文本
  raw_hash        TEXT NOT NULL     -- SHA-256，用于 heartbeat handler 去重
);

CREATE INDEX IF NOT EXISTS idx_calibration_instrument_time
  ON calibration (instrument_id, calibrated_at DESC);

-- 处理记录（含状态机字段）
CREATE TABLE IF NOT EXISTS processing_record (
  record_id       TEXT PRIMARY KEY,
  instrument_id   TEXT NOT NULL REFERENCES instrument(instrument_id),
  alarm_code      TEXT NOT NULL,
  operator_id     TEXT NOT NULL,
  root_cause      TEXT NOT NULL DEFAULT '',
  steps_json      TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  confirmed_at    TEXT,
  state           TEXT NOT NULL CHECK (state IN
                    ('received', 'parsed', 'verified', 'writeback_pending',
                     'written_back', 'failed')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  accession_no    TEXT
);

CREATE INDEX IF NOT EXISTS idx_proc_record_instrument ON processing_record (instrument_id);

-- plugin manifest
CREATE TABLE IF NOT EXISTS plugin_manifest (
  name         TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('api', 'task', 'unfurl', 'uninstall')),
  hooks_json   TEXT NOT NULL DEFAULT '[]',
  queue_name   TEXT,
  auth_json    TEXT,
  rate_limit   INTEGER,
  installed_at TEXT NOT NULL
);

-- 事件去重（plugin_event_dedupe）：event_id UNIQUE
-- 用途：队列入队前查表，已存在则 skip
CREATE TABLE IF NOT EXISTS plugin_event_dedupe (
  event_id   TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  ts         TEXT NOT NULL
);

-- append-only audit_event：trigger 阻止 UPDATE/DELETE
CREATE TABLE IF NOT EXISTS audit_event (
  event_id          TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  req_hash          TEXT,
  resp_hash         TEXT,
  operator_id       TEXT,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  ts                TEXT NOT NULL,
  related_event_id  TEXT REFERENCES audit_event(event_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_kind_time ON audit_event (kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_operator ON audit_event (operator_id, ts DESC);

-- append-only 触发器（trigger CHECK(0) 在条件为 true 时抛错）
CREATE TRIGGER IF NOT EXISTS audit_event_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS audit_event_no_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only: DELETE not allowed');
END;

-- 迁移记录表（migrate.ts 用）
CREATE TABLE IF NOT EXISTS migration_log (
  filename    TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

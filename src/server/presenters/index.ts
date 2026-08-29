// src/server/presenters/index.ts
//
// 统一出口：re-export 所有 presenter 与形态，便于 routes 层按需引用。
//
// 这是 contract v1 的真源（待 Task 24 在 contracts.ts 里加 Zod schema 锁字段）。

export {
  presentInstrument,
  presentInstruments,
  type PresentedInstrument,
  type InstrumentRow,
} from './instrument.js';

export {
  presentAlarmCode,
  presentAlarmCodes,
  alarmJoinKey,
  type PresentedAlarmCode,
  type AlarmCodeRow,
} from './alarmCode.js';

export {
  presentCalibration,
  presentCalibrations,
  type PresentedCalibration,
  type CalibrationRow,
} from './calibration.js';

export {
  presentProcessingRecord,
  presentProcessingRecords,
  type PresentedProcessingRecord,
  type ProcessingRecordRow,
} from './processingRecord.js';

export {
  presentPlugin,
  presentPlugins,
  computeListeningPath,
  type PresentedPlugin,
} from './plugin.js';

export {
  presentAuditEvent,
  presentAuditEvents,
  type PresentedAuditEvent,
  type AuditEventRow,
} from './auditEvent.js';
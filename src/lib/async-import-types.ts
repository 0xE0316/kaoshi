import type { ShipmentRow } from "@/lib/types";

export const IMPORT_BATCH_SIZE = 500;
export const IMPORT_MAX_RETRIES = 3;

export type ImportTaskStatus = "pending" | "processing" | "completed" | "partial_success" | "failed";
export type ImportUnitStatus = "pending" | "processing" | "completed" | "failed";
export type OutboxStatus = "pending" | "sent" | "failed";
export type ImportErrorCode = "E001" | "E002" | "E003" | "E004" | "E005" | "E006" | "E007" | "E008" | "E009";

export function finalImportTaskStatus(successRows: number, failedRows: number): Extract<ImportTaskStatus, "completed" | "partial_success" | "failed"> {
  if (failedRows === 0) return "completed";
  return successRows > 0 ? "partial_success" : "failed";
}

export type ImportTask = {
  id: string;
  fileName: string;
  fileHash: string;
  ruleId: string;
  status: ImportTaskStatus;
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  totalBatches: number;
  completedBatches: number;
  traceId: string;
  degraded: boolean;
  degradedReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  recentError: string | null;
  throughputPerMinute: number;
  estimatedSecondsRemaining: number | null;
};

export type ImportTaskBatch = {
  id: string;
  taskId: string;
  unitId: string;
  batchIndex: number;
  startRow: number;
  endRow: number;
  status: ImportUnitStatus;
  retryCount: number;
  successRows: number;
  failedRows: number;
  lockedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
};

export type ImportTaskError = {
  id: string;
  taskId: string;
  unitId: string;
  batchIndex: number;
  rowNumber: number;
  fieldName: string;
  rawValue: string;
  errorCode: ImportErrorCode;
  errorReason: string;
  suggestion: string;
  ruleId: string;
  traceId: string;
  createdAt: string;
};

export type BatchPerformance = {
  unitId: string;
  batchIndex: number;
  parseDurationMs: number;
  ruleDurationMs: number;
  validateDurationMs: number;
  insertDurationMs: number;
  totalDurationMs: number;
  status: ImportUnitStatus;
  retryCount: number;
};

export type TraceEvent = {
  id: string;
  traceId: string;
  taskId: string;
  unitId: string | null;
  eventName: string;
  eventStatus: "info" | "success" | "warning" | "error";
  message: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
};

export type ImportEventPayloadMap = {
  ImportTaskCreated: { task_id: string };
  ImportBatchCreated: { task_id: string; unit_id: string; batch_index: number; start_row: number; end_row: number };
  ImportBatchStarted: { task_id: string; unit_id: string; batch_index: number; retry_count: number };
  ImportBatchSucceeded: { task_id: string; unit_id: string; batch_index: number; success_rows: number; failed_rows: number };
  ImportBatchFailed: { task_id: string; unit_id: string; batch_index: number; retry_count: number; retryable: boolean; reason: string };
  ImportTaskCompleted: { task_id: string };
  ImportTaskPartialSuccess: { task_id: string; failed_rows: number };
  ImportTaskFailed: { task_id: string; failed_rows: number; reason: string };
  ImportTaskDegraded: { task_id: string; unit_id: string; batch_index: number; reason: string };
};

export type ImportEventType = keyof ImportEventPayloadMap;

export type ImportEventEnvelope<T extends ImportEventType = ImportEventType> = {
  event_id: string;
  event_type: T;
  schema_version: 1;
  aggregate_id: string;
  trace_id: string;
  occurred_at: string;
  payload: ImportEventPayloadMap[T];
};

export type ImportTaskCreatedEvent = ImportEventEnvelope<"ImportTaskCreated">;
export type ImportBatchCreatedEvent = ImportEventEnvelope<"ImportBatchCreated">;
export type ImportParseEventEnvelope = ImportTaskCreatedEvent;

export type ImportQueueEvent = ImportTaskCreatedEvent | ImportBatchCreatedEvent;

export function isImportTaskCreatedEvent(value: unknown): value is ImportTaskCreatedEvent {
  if (!isRecord(value) || value.schema_version !== 1 || value.event_type !== "ImportTaskCreated" || !isRecord(value.payload)) return false;
  return typeof value.event_id === "string" && typeof value.aggregate_id === "string" && typeof value.trace_id === "string" && typeof value.occurred_at === "string" && typeof value.payload.task_id === "string";
}

export function isImportBatchCreatedEvent(value: unknown): value is ImportBatchCreatedEvent {
  if (!isRecord(value) || value.schema_version !== 1 || value.event_type !== "ImportBatchCreated" || !isRecord(value.payload)) return false;
  return typeof value.event_id === "string" && typeof value.aggregate_id === "string" && typeof value.trace_id === "string" && typeof value.occurred_at === "string" && typeof value.payload.task_id === "string" && typeof value.payload.unit_id === "string" && Number.isInteger(value.payload.batch_index) && Number.isInteger(value.payload.start_row) && Number.isInteger(value.payload.end_row);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type StagedImportPayload = {
  rows: ShipmentRow[];
};

export type MonitorSummary = {
  generatedAt: string;
  queue: { pendingBatches: number; pendingRows: number; available: boolean; alert: "normal" | "warning" | "critical" };
  throughput: Array<{ minute: string; rows: number }>;
  durationPercentiles: Record<"parse" | "rule" | "validate" | "insert" | "total", { p50: number; p95: number; p99: number }>;
  errors: Array<{ code: string; count: number; percentage: number }>;
  slowBatches: Array<{ taskId: string; unitId: string; batchIndex: number; totalDurationMs: number }>;
  failedTaskTrend: Array<{ minute: string; count: number }>;
  alerts: Array<{ type: "queue" | "dead_letter" | "failed_task" | "slow_batch"; severity: "warning" | "critical"; message: string; count: number }>;
};

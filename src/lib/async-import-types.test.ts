import { describe, expect, it } from "vitest";
import { finalImportTaskStatus, isImportBatchCreatedEvent, isImportTaskCreatedEvent } from "@/lib/async-import-types";
import type { ImportBatchCreatedEvent, ImportParseEventEnvelope } from "@/lib/async-import-types";

describe("event contracts", () => {
  it("keeps schema version and trace id in parse and batch events", () => {
    const parse: ImportParseEventEnvelope = { event_id: "evt-1", event_type: "ImportTaskCreated", schema_version: 1, aggregate_id: "task-1", trace_id: "trace-1", occurred_at: new Date(0).toISOString(), payload: { task_id: "task-1" } };
    const batch: ImportBatchCreatedEvent = { event_id: "evt-2", event_type: "ImportBatchCreated", schema_version: 1, aggregate_id: "task-1", trace_id: parse.trace_id, occurred_at: parse.occurred_at, payload: { task_id: "task-1", unit_id: "unit_0001", batch_index: 1, start_row: 1, end_row: 500 } };
    expect(parse.schema_version).toBe(1);
    expect(batch.trace_id).toBe(parse.trace_id);
    expect(batch.payload.end_row - batch.payload.start_row + 1).toBe(500);
  });

  it("accepts additive unknown fields but rejects invalid payloads", () => {
    const task = { event_id: "evt-1", event_type: "ImportTaskCreated", schema_version: 1, aggregate_id: "task-1", trace_id: "trace-1", occurred_at: new Date(0).toISOString(), payload: { task_id: "task-1", future_field: true }, future_envelope_field: true };
    expect(isImportTaskCreatedEvent(task)).toBe(true);
    expect(isImportBatchCreatedEvent({ ...task, event_type: "ImportBatchCreated" })).toBe(false);
  });
});

describe("task status aggregation", () => {
  it("distinguishes complete, partial and all-failed results", () => {
    expect(finalImportTaskStatus(100, 0)).toBe("completed");
    expect(finalImportTaskStatus(99, 1)).toBe("partial_success");
    expect(finalImportTaskStatus(0, 100)).toBe("failed");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportBatchCreatedEvent } from "@/lib/async-import-types";
import { makeBlankShipmentRow } from "@/lib/validation";

const storage = vi.hoisted(() => ({
  addLifecycleTrace: vi.fn(),
  batchSkuLookup: vi.fn(),
  claimBatch: vi.fn(),
  claimFileParse: vi.fn(),
  completeBatch: vi.fn(),
  currentTaskOrderReceivers: vi.fn(),
  existingExternalCodes: vi.fn(),
  failBatch: vi.fn(),
  failFileParse: vi.fn(),
  getImportSource: vi.fn(),
  getStagedRows: vi.fn(),
  stageParsedRows: vi.fn(),
}));

vi.mock("@/lib/server/async-import-storage", () => storage);
vi.mock("@/lib/server/storage", () => ({ getRule: vi.fn() }));

import { processImportBatch } from "@/lib/server/import-worker";

const event: ImportBatchCreatedEvent = {
  event_id: "evt-1",
  event_type: "ImportBatchCreated",
  schema_version: 1,
  aggregate_id: "task-1",
  trace_id: "trace-1",
  occurred_at: new Date(0).toISOString(),
  payload: { task_id: "task-1", unit_id: "unit-1", batch_index: 1, start_row: 1, end_row: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  storage.claimBatch.mockResolvedValue({ retryCount: 1 });
  storage.getImportSource.mockResolvedValue({ file_name: "orders.xlsx", rule_id: "rule-1", total_rows: 2, parse_duration_ms: 10, rule_duration_ms: 20 });
  storage.existingExternalCodes.mockResolvedValue(new Set());
  storage.currentTaskOrderReceivers.mockResolvedValue(new Map());
  storage.completeBatch.mockResolvedValue({ status: "completed" });
  storage.addLifecycleTrace.mockResolvedValue(undefined);
});

describe("batch worker lifecycle", () => {
  it("performs one batch SKU lookup and writes successful rows", async () => {
    const rows = stagedRows();
    storage.getStagedRows.mockResolvedValue(rows);
    storage.batchSkuLookup.mockResolvedValue(new Set(["SKU-1", "SKU-2"]));

    const result = await processImportBatch(event);

    expect(storage.batchSkuLookup).toHaveBeenCalledOnce();
    expect(storage.batchSkuLookup).toHaveBeenCalledWith(["SKU-1", "SKU-2"]);
    expect(storage.addLifecycleTrace).toHaveBeenCalledWith(expect.objectContaining({ eventType: "ImportBatchStarted" }));
    expect(storage.completeBatch).toHaveBeenCalledWith(expect.objectContaining({ errors: [], degraded: false }));
    expect(result).toMatchObject({ status: "completed", successRows: 2, failedRows: 0 });
  });

  it("records a precise row error while allowing valid rows to continue", async () => {
    storage.getStagedRows.mockResolvedValue(stagedRows());
    storage.batchSkuLookup.mockResolvedValue(new Set(["SKU-1"]));

    const result = await processImportBatch(event);
    const call = storage.completeBatch.mock.calls[0][0];

    expect(call.errors).toEqual([expect.objectContaining({ rowNumber: 2, fieldName: "skuCode", errorCode: "E001" })]);
    expect(result).toMatchObject({ successRows: 1, failedRows: 1 });
  });

  it("marks every row unverified and continues in explicit degradation mode", async () => {
    storage.getStagedRows.mockResolvedValue(stagedRows());
    storage.batchSkuLookup.mockRejectedValue(new Error("SKU_LOOKUP_TIMEOUT"));

    const result = await processImportBatch(event);
    const call = storage.completeBatch.mock.calls[0][0];

    expect(call.degraded).toBe(true);
    expect(call.degradedReason).toBe("SKU_LOOKUP_TIMEOUT");
    expect(call.errors).toHaveLength(2);
    expect(call.errors.every((item: { errorCode: string }) => item.errorCode === "E009")).toBe(true);
    expect(result).toMatchObject({ successRows: 2, failedRows: 0, degraded: true });
  });

  it("returns immediately for duplicate delivery of a claimed or completed unit", async () => {
    storage.claimBatch.mockResolvedValue(null);

    await expect(processImportBatch(event)).resolves.toEqual({ status: "already_claimed_or_completed" });
    expect(storage.getImportSource).not.toHaveBeenCalled();
    expect(storage.completeBatch).not.toHaveBeenCalled();
  });
});

function stagedRows() {
  return [
    { rowNumber: 1, row: makeBlankShipmentRow({ externalCode: "ORDER-1", storeName: "门店 A", skuCode: "SKU-1", skuName: "商品一", skuQty: "1", temperatureZone: "常温" }) },
    { rowNumber: 2, row: makeBlankShipmentRow({ externalCode: "ORDER-2", storeName: "门店 B", skuCode: "SKU-2", skuName: "商品二", skuQty: "2", temperatureZone: "冷藏" }) },
  ];
}

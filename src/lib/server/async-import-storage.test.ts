import { afterEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const transactions: Array<Array<{ text: string; values: unknown[] }>> = [];
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("?"), values })),
    {
      transaction: vi.fn(async (callback: () => Array<{ text: string; values: unknown[] }>) => {
        const result = callback();
        transactions.push(result);
        statements.push(...result);
        return [];
      }),
    },
  );
  return { sql, statements, transactions };
});

vi.mock("@neondatabase/serverless", () => ({ neon: () => database.sql }));
vi.mock("@/lib/server/storage", () => ({ ensureV2Schema: vi.fn() }));

import { createImportTask, makeOrderPayload } from "@/lib/server/async-import-storage";
import type { ShipmentRow } from "@/lib/types";

const originalRuntimeMigration = process.env.ALLOW_RUNTIME_SCHEMA_MIGRATION;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  database.statements.length = 0;
  database.transactions.length = 0;
  if (originalRuntimeMigration === undefined) delete process.env.ALLOW_RUNTIME_SCHEMA_MIGRATION;
  else process.env.ALLOW_RUNTIME_SCHEMA_MIGRATION = originalRuntimeMigration;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("async task transaction", () => {
  it("commits task, task-created Outbox and batch records together", async () => {
    process.env.ALLOW_RUNTIME_SCHEMA_MIGRATION = "false";
    process.env.DATABASE_URL = "postgresql://test.invalid/db";
    await createImportTask({
      id: "task-1", traceId: "trace-1", fileName: "orders.xlsx", fileHash: "hash", contentType: "application/xlsx", fileData: "ZmlsZQ==", ruleId: "rule-1", totalRows: 2,
      batches: [{ unitId: "unit-1", batchIndex: 1, startRow: 1, endRow: 2 }],
    });

    expect(database.transactions).toHaveLength(1);
    const transactionSql = database.transactions[0].map((statement) => statement.text).join("\n");
    expect(transactionSql).toContain("insert into import_tasks");
    expect(transactionSql).toContain("insert into event_outbox");
    expect(transactionSql).toContain("insert into import_task_batches");
    const outbox = database.transactions[0].find((statement) => statement.text.includes("event_outbox"));
    expect(JSON.stringify(outbox?.values)).toContain("ImportTaskCreated");
  });
});

describe("shipment order aggregation", () => {
  it("persists the first batch with its real SKU count, quantity and row IDs", () => {
    const rows = [
      shipmentRow("row-1", "EXT-1", "SKU-1", "2"),
      shipmentRow("row-2", "EXT-1", "SKU-2", "3"),
    ].map((row, index) => ({ row, rowNumber: index + 1 }));

    expect(makeOrderPayload("task-1", rows)).toEqual([
      expect.objectContaining({
        external_code: "EXT-1",
        sku_count: 2,
        total_qty: 5,
        row_ids: ["row-1", "row-2"],
      }),
    ]);
  });
});

function shipmentRow(id: string, externalCode: string, skuCode: string, skuQty: string): ShipmentRow {
  return {
    id,
    externalCode,
    storeName: "测试门店",
    recipientName: "",
    recipientPhone: "",
    recipientAddress: "",
    skuCode,
    skuName: skuCode,
    skuQty,
    skuSpec: "",
    temperatureZone: "常温",
    remark: "",
  };
}

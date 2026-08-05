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

import { createImportTask } from "@/lib/server/async-import-storage";

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

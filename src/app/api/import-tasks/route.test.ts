import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportTask } from "@/lib/async-import-types";

const storage = vi.hoisted(() => ({ createImportTask: vi.fn(), findRecentTaskByHash: vi.fn() }));
const dispatchOutbox = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/async-import-storage", () => storage);
vi.mock("@/lib/server/import-queue", () => ({ dispatchOutbox }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (callback: () => unknown) => void callback() };
});

import { POST } from "@/app/api/import-tasks/route";

const task: ImportTask = {
  id: "task-1", fileName: "orders.xlsx", fileHash: "hash", ruleId: "rule-1", status: "pending",
  totalRows: 10_000, processedRows: 0, successRows: 0, failedRows: 0, totalBatches: 20,
  completedBatches: 0, traceId: "trace-1", degraded: false, degradedReason: null,
  createdAt: new Date(0).toISOString(), startedAt: null, completedAt: null, lastHeartbeatAt: null,
  recentError: null, throughputPerMinute: 0, estimatedSecondsRemaining: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  storage.findRecentTaskByHash.mockResolvedValue(null);
  storage.createImportTask.mockResolvedValue(task);
  dispatchOutbox.mockResolvedValue({ sent: 1 });
});

describe("POST /api/import-tasks", () => {
  it("returns a task without parsing the full file in the request", async () => {
    const form = new FormData();
    form.set("file", new File(["small-fixture"], "orders.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    form.set("ruleId", "rule-1");
    form.set("totalRows", "10000");
    const startedAt = performance.now();

    const response = await POST(new Request("http://localhost/api/import-tasks", { method: "POST", body: form }));
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ task_id: "task-1", trace_id: "trace-1", total_rows: 10000, total_batches: 20 });
    expect(storage.createImportTask).toHaveBeenCalledWith(expect.objectContaining({ totalRows: 10000 }));
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("rejects missing or invalid row-count metadata", async () => {
    const form = new FormData();
    form.set("file", new File(["fixture"], "orders.xlsx"));
    form.set("ruleId", "rule-1");
    const response = await POST(new Request("http://localhost/api/import-tasks", { method: "POST", body: form }));
    expect(response.status).toBe(400);
    expect(storage.createImportTask).not.toHaveBeenCalled();
  });
});

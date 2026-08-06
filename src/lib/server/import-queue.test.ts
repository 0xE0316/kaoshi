import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const publishJSON = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ addTrace: vi.fn(), listOutbox: vi.fn(), markOutboxFailed: vi.fn(), markOutboxSent: vi.fn() }));

vi.mock("@upstash/qstash", () => ({ Client: class { publishJSON = publishJSON; }, Receiver: class {} }));
vi.mock("@/lib/server/async-import-storage", () => storage);

import { dispatchOutbox } from "@/lib/server/import-queue";

const originalToken = process.env.QSTASH_TOKEN;
const record = {
  id: "outbox-1",
  payload: { event_id: "evt-1", event_type: "ImportTaskCreated", schema_version: 1, aggregate_id: "task-1", trace_id: "trace-1", occurred_at: new Date(0).toISOString(), payload: { task_id: "task-1" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QSTASH_TOKEN = "test-token";
  storage.listOutbox.mockResolvedValue([record]);
});

describe("Outbox dispatcher recovery", () => {
  it("leaves a failed event retryable and sends it on a later dispatch", async () => {
    publishJSON.mockRejectedValueOnce(new Error("queue unavailable")).mockResolvedValueOnce({ messageId: "msg-1" });
    await expect(dispatchOutbox("http://localhost")).resolves.toMatchObject({ sent: 0, failed: 1, available: false });
    expect(storage.markOutboxFailed).toHaveBeenCalledWith("outbox-1", "queue unavailable");

    await expect(dispatchOutbox("http://localhost")).resolves.toMatchObject({ sent: 1, failed: 0, available: true });
    expect(storage.markOutboxSent).toHaveBeenCalledWith("outbox-1");
  });
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.QSTASH_TOKEN;
  else process.env.QSTASH_TOKEN = originalToken;
});

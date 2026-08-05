import { describe, expect, it, vi } from "vitest";

const searchTrace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/async-import-storage", () => ({ searchTrace }));

import { GET } from "@/app/api/traces/route";

describe("Trace search API", () => {
  it("rejects an unbounded query", async () => {
    const response = await GET(new Request("http://localhost/api/traces"));
    expect(response.status).toBe(400);
    expect(searchTrace).not.toHaveBeenCalled();
  });

  it("maps all supported filters to the storage query", async () => {
    searchTrace.mockResolvedValue({ tasks: [], events: [], errors: [] });
    const response = await GET(new Request("http://localhost/api/traces?task_id=task-1&trace_id=trace-1&file_name=a.xlsx&batch=2&row_from=10&row_to=20&error_code=E001"));
    expect(response.status).toBe(200);
    expect(searchTrace).toHaveBeenCalledWith({ taskId: "task-1", traceId: "trace-1", fileName: "a.xlsx", batch: 2, rowFrom: 10, rowTo: 20, errorCode: "E001" });
  });
});

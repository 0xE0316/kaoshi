import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentRule, NormalizedDocument } from "@/lib/types";
import { hasKimiCredentials, suggestRuleWithKimi } from "@/lib/server/kimi";

const fetchMock = vi.fn();
const originalEnv = {
  apiKey: process.env.KIMI_API_KEY,
  baseUrl: process.env.KIMI_BASE_URL,
  model: process.env.KIMI_MODEL,
};

const rule = {
  id: "rule-test",
  name: "测试规则",
  description: "验证 Kimi 客户端请求协议",
  sourceType: "excel",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  extractor: {
    kind: "tabular",
    headerRow: 1,
    dataStartRow: 2,
    sheetSelector: { mode: "first" },
    fieldMappings: [],
  },
} satisfies DocumentRule;

const document = {
  fileName: "test.xlsx",
  fileType: "excel",
  fullText: "配送单号 | SKU",
  sheets: [],
  pages: [],
  summary: {
    fileName: "test.xlsx",
    fileType: "excel",
    sheetCount: 1,
    pageCount: 0,
    textPreview: "配送单号 | SKU",
    labelCandidates: [],
    sheetPreviews: [],
  },
} satisfies NormalizedDocument;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.KIMI_API_KEY = "test-key";
  process.env.KIMI_BASE_URL = "https://kimi.example/v1/";
  process.env.KIMI_MODEL = "kimi-k3-account-model";
});

describe("Kimi client", () => {
  it("uses Moonshot-compatible bearer authentication and model override", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(rule) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(suggestRuleWithKimi({ document, heuristicRule: rule })).resolves.toMatchObject({ id: rule.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://kimi.example/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "kimi-k3-account-model", stream: false });
  });

  it("retries rate limits but does not retry authentication errors", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rule) } }] }), { status: 200 }));
    await suggestRuleWithKimi({ document, heuristicRule: rule });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(new Response("invalid key", { status: 401 }));
    await expect(suggestRuleWithKimi({ document, heuristicRule: rule })).rejects.toThrow("401 invalid key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports missing credentials before sending a request", async () => {
    delete process.env.KIMI_API_KEY;
    expect(hasKimiCredentials()).toBe(false);
    await expect(suggestRuleWithKimi({ document, heuristicRule: rule })).rejects.toThrow("缺少 KIMI_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("KIMI_API_KEY", originalEnv.apiKey);
  restoreEnv("KIMI_BASE_URL", originalEnv.baseUrl);
  restoreEnv("KIMI_MODEL", originalEnv.model);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

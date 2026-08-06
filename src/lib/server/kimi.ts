import {
  KIMI_BASE_URL,
  KIMI_MAX_RETRIES,
  KIMI_MODEL,
  KIMI_PROVIDER_LABEL,
  KIMI_TIMEOUT_MS,
} from "@/lib/constants";
import type { DocumentRule, NormalizedDocument, ShipmentRow } from "@/lib/types";
import { extractFirstJsonObject, safeJsonParse } from "@/lib/utils";
import { makeBlankShipmentRow } from "@/lib/validation";

type KimiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type KimiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

export function hasKimiCredentials() {
  return Boolean(process.env.KIMI_API_KEY);
}

export async function suggestRuleWithKimi(input: {
  document: NormalizedDocument;
  heuristicRule: DocumentRule;
}) {
  const response = await callKimiChat([
    {
      role: "system",
      content:
        "你是物流下单规则引擎专家。你只能输出 JSON，不要输出解释。请根据文档摘要和现有启发式规则，返回可直接执行的规则对象。规则中若字段映射不确定，请把 uncertain 设为 true，并在 confidenceNotes 中说明原因。",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "生成物流导入规则",
          fileName: input.document.fileName,
          fileType: input.document.fileType,
          documentSummary: buildRuleSuggestionContext(input.document),
          heuristicRule: input.heuristicRule,
          requiredFields: [
            "externalCode",
            "storeName",
            "recipientName",
            "recipientPhone",
            "recipientAddress",
            "skuCode",
            "skuName",
            "skuQty",
            "skuSpec",
            "temperatureZone",
            "remark",
          ],
        },
        null,
        2,
      ),
    },
  ]);

  return safeJsonParse<DocumentRule>(
    extractFirstJsonObject(response),
    input.heuristicRule,
  );
}

export async function parseStructuredRowsWithKimi(input: {
  document: NormalizedDocument;
  rule: DocumentRule;
}) {
  const response = await callKimiChat([
    {
      role: "system",
      content:
        "你是物流运单结构化助手。你只能输出 JSON，对象格式为 { rows: ShipmentRow[], notes: string[] }。每一行必须包含：externalCode, storeName, recipientName, recipientPhone, recipientAddress, skuCode, skuName, skuQty, skuSpec, temperatureZone, remark。无法确认的值返回空字符串，并在 notes 说明。",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "按规则抽取结构化运单",
          rule: input.rule,
          documentSummary: input.document.summary,
          documentText: input.document.fullText.slice(0, 18000),
        },
        null,
        2,
      ),
    },
  ]);

  const parsed = safeJsonParse<{ rows?: Partial<ShipmentRow>[]; notes?: string[] }>(
    extractFirstJsonObject(response),
    { rows: [], notes: [] },
  );

  return {
    rows: (parsed.rows ?? []).map((row) => makeBlankShipmentRow(row)),
    notes: parsed.notes ?? [],
  };
}

async function callKimiChat(messages: KimiMessage[]) {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    throw new Error(`缺少 KIMI_API_KEY，无法调用 ${KIMI_PROVIDER_LABEL}。`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= KIMI_MAX_RETRIES; attempt += 1) {
    try {
      return await requestKimiChat(apiKey, messages);
    } catch (error) {
      lastError = error;
      if (attempt === KIMI_MAX_RETRIES || !isRetryable(error)) throw error;
      await delay(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function requestKimiChat(apiKey: string, messages: KimiMessage[]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIMI_TIMEOUT_MS);

  try {
    const response = await fetch(`${trimTrailingSlash(process.env.KIMI_BASE_URL ?? KIMI_BASE_URL)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.KIMI_MODEL ?? KIMI_MODEL,
        max_tokens: 1800,
        stream: false,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new KimiRequestError(response.status, `${KIMI_PROVIDER_LABEL} 调用失败：${response.status} ${detail}`);
    }

    const payload = (await response.json()) as KimiChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (Array.isArray(content)) return content.map((item) => item.text ?? "").join("\n");
    if (!content) throw new Error(`${KIMI_PROVIDER_LABEL} 返回内容为空。`);
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KimiRequestError(408, `${KIMI_PROVIDER_LABEL} 调用超过 45 秒，已超时。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

class KimiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "KimiRequestError";
  }
}

function isRetryable(error: unknown) {
  return error instanceof KimiRequestError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function buildRuleSuggestionContext(document: NormalizedDocument) {
  return {
    fileName: document.fileName,
    fileType: document.fileType,
    sheetCount: document.summary.sheetCount,
    pageCount: document.summary.pageCount,
    labelCandidates: document.summary.labelCandidates.slice(0, 16),
    textPreview: document.summary.textPreview.slice(0, 2200),
    sheetSnapshots: document.summary.sheetPreviews.slice(0, 2).map((sheet) => ({
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      firstRows: trimRows(sheet.firstRows, 4),
      lastRows: trimRows(sheet.lastRows, 2),
    })),
  };
}

function trimRows(rows: string[][], limit: number) {
  return rows.slice(0, limit).map((row) => row.slice(0, 12));
}

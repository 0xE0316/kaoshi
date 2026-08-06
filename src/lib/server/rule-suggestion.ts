import { demoRules } from "@/lib/demo-rules";
import { parseDocumentWithRule } from "@/lib/rule-engine";
import type { DocumentRule, FieldMapping, NormalizedDocument } from "@/lib/types";
import { deepClone, makeId } from "@/lib/utils";

const fieldHeaderCandidates: Record<string, string[]> = {
  externalCode: ["外部编码", "配送单号", "单据号", "配送汇总单号", "订单号"],
  storeName: ["收货机构", "收货门店", "门店", "门店名称", "调入门店"],
  recipientName: ["收货人", "收件人", "联系人"],
  recipientPhone: ["收货电话", "联系电话", "电话", "手机"],
  recipientAddress: ["收货地址", "地址"],
  skuCode: ["SKU物品编码", "物品编码", "SKU条码", "外部商品编码"],
  skuName: ["SKU物品名称", "物品名称", "SKU名称"],
  skuQty: ["SKU发货数量", "发货数量", "出库数量", "数量"],
  skuSpec: ["SKU规格型号", "规格型号", "规格"],
  remark: ["备注", "单据备注", "说明"],
};

export async function buildHeuristicRule(document: NormalizedDocument): Promise<DocumentRule> {
  const bestTemplate = await findBestExecutableTemplate(document);
  if (bestTemplate) {
    return materializeTemplate(
      bestTemplate.rule.id,
      document,
      `已用候选规则进行本地试解析评分，推荐从“${bestTemplate.rule.name}”继续微调；预览 ${bestTemplate.rowCount} 行，阻断错误 ${bestTemplate.errorCount} 项。`,
    );
  }

  if (document.fileType === "excel") {
    return buildGenericTabularRule(document);
  }

  return {
    id: makeId("rule"),
    name: `AI 推荐规则 - ${document.fileName}`,
    description: "未命中特定结构，先使用 AI 结构化提取兜底。",
    sourceType: document.fileType,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    aiSummary: "未识别到稳定表格结构，建议走 AI 结构化模式并由用户二次确认。",
    confidenceNotes: [
      {
        field: "extractor",
        level: "guess",
        message: "当前文档结构不够稳定，建议通过 Kimi 先生成规则，再手动微调。",
      },
    ],
    extractor: {
      kind: "llmStructured",
      instruction:
        "请提取物流出库单的收货信息和 SKU 行。A/B 组字段规则：收货门店，或收件人姓名+电话+地址，至少一组有效。",
      extractionTarget: "documentSummary",
      defaults: [{ field: "temperatureZone", value: "常温" }],
    },
  };
}

async function findBestExecutableTemplate(document: NormalizedDocument) {
  const candidates = demoRules.filter(
    (rule) =>
      rule.extractor.kind !== "llmStructured" &&
      (rule.sourceType === document.fileType || rule.sourceType === "mixed"),
  );

  const scored = await Promise.all(
    candidates.map(async (rule) => {
      try {
        const preview = await parseDocumentWithRule(document, rule, { existingExternalCodes: [] });
        const errorCount = preview.issues.filter((issue) => issue.severity === "error").length;
        const warningCount = preview.issues.filter((issue) => issue.severity === "warning").length;
        const fieldCoverage = countMappedBusinessFields(rule);
        return {
          rule,
          rowCount: preview.rows.length,
          errorCount,
          score: preview.rows.length * 10 + fieldCoverage * 2 - errorCount * 5 - warningCount,
        };
      } catch {
        return {
          rule,
          rowCount: 0,
          errorCount: Number.MAX_SAFE_INTEGER,
          score: Number.NEGATIVE_INFINITY,
        };
      }
    }),
  );

  return scored
    .filter((item) => item.rowCount > 0 && item.score > 0)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function countMappedBusinessFields(rule: DocumentRule) {
  const serialized = JSON.stringify(rule.extractor);
  return fieldHeaderCandidates
    ? Object.keys(fieldHeaderCandidates).filter((field) => serialized.includes(`"field":"${field}"`)).length
    : 0;
}

function buildGenericTabularRule(document: NormalizedDocument): DocumentRule {
  const sheet = document.sheets[0];
  const headerIndex = inferHeaderRowIndex(sheet.rows);
  const header = sheet.rows[headerIndex] ?? [];
  const fieldMappings: FieldMapping[] = [];

  Object.entries(fieldHeaderCandidates).forEach(([field, candidates]) => {
    const matched = findMatchedHeader(header, candidates);
    if (!matched) {
      return;
    }

    fieldMappings.push({
      field: field as FieldMapping["field"],
      source: { kind: "header", header: matched },
      transforms: field === "skuQty" ? [{ kind: "numberString" }] : undefined,
    });
  });

  return {
    id: makeId("rule"),
    name: `AI 推荐规则 - ${document.fileName}`,
    description: "通用表格规则：自动定位首个高密度表头，并按列名映射字段。",
    sourceType: "excel",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    aiSummary: `已自动选择第 ${headerIndex + 1} 行作为表头。建议用“试解析”确认尾部信息和默认值。`,
    confidenceNotes: [
      {
        field: "extractor",
        level: "guess",
        message: "表头由启发式识别，若存在合并单元格或说明行，建议再调整 headerRow / dataStartRow。",
      },
    ],
    extractor: {
      kind: "tabular",
      sheetSelector: { mode: "first" },
      headerRow: headerIndex + 1,
      dataStartRow: headerIndex + 2,
      fieldMappings,
      rowFilters: fieldMappings.some((mapping) => mapping.field === "skuCode")
        ? [{ kind: "notEmpty", source: { kind: "header", header: fieldMappings.find((item) => item.field === "skuCode")?.source.kind === "header" ? (fieldMappings.find((item) => item.field === "skuCode")?.source as { header: string }).header : "物品编码" } }]
        : undefined,
      defaults: [{ field: "temperatureZone", value: "常温" }],
    },
  };
}

function inferHeaderRowIndex(rows: string[][]) {
  let bestIndex = 0;
  let bestScore = -1;

  rows.slice(0, 10).forEach((row, index) => {
    const nonEmpty = row.filter((cell) => cell.trim()).length;
    if (nonEmpty > bestScore) {
      bestScore = nonEmpty;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function materializeTemplate(templateId: string, document: NormalizedDocument, aiSummary: string) {
  const template = demoRules.find((item) => item.id === templateId);
  if (!template) {
    throw new Error(`找不到模板规则：${templateId}`);
  }

  const cloned = deepClone(template);
  return {
    ...cloned,
    id: makeId("rule"),
    name: `${cloned.name} · AI 推荐`,
    sampleFileName: document.fileName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    aiSummary,
  };
}

function normalize(value: string) {
  return value.replace(/[：:\s*＊]/g, "");
}

function findMatchedHeader(headerRow: string[], candidates: string[]) {
  return headerRow.find((cell) => candidates.some((candidate) => normalize(cell) === normalize(candidate))) ?? null;
}

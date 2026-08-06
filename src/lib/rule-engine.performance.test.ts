import { describe, expect, it } from "vitest";

import { parseDocumentWithRule } from "@/lib/rule-engine";
import type { DocumentRule, NormalizedDocument } from "@/lib/types";

describe("tabular rule performance", () => {
  it("parses 10,000 rows without rebuilding the full sheet text per row", async () => {
    const header = ["外部编码", "收货门店", "SKU物品编码", "SKU物品名称", "SKU发货数量", "温层"];
    const data = Array.from({ length: 10_000 }, (_, index) => [
      `EXT-${index}`,
      `门店-${index % 200}`,
      `SKU-${index}`,
      `商品-${index}`,
      String(index % 5 + 1),
      "常温",
    ]);
    const rows = [header, ...data];
    const document: NormalizedDocument = {
      fileName: "performance.xlsx",
      fileType: "excel",
      fullText: "",
      pages: [],
      sheets: [{ name: "Sheet1", rows, rowCount: rows.length, columnCount: header.length }],
      summary: {
        fileName: "performance.xlsx",
        fileType: "excel",
        sheetCount: 1,
        pageCount: 0,
        textPreview: "",
        labelCandidates: [],
        sheetPreviews: [],
      },
    };
    const rule: DocumentRule = {
      id: "rule-performance",
      name: "性能回归规则",
      description: "验证标准表格线性解析复杂度",
      sourceType: "excel",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      extractor: {
        kind: "tabular",
        sheetSelector: { mode: "first" },
        headerRow: 1,
        dataStartRow: 2,
        fieldMappings: [
          { field: "externalCode", source: { kind: "header", header: "外部编码" } },
          { field: "storeName", source: { kind: "header", header: "收货门店" } },
          { field: "skuCode", source: { kind: "header", header: "SKU物品编码" } },
          { field: "skuName", source: { kind: "header", header: "SKU物品名称" } },
          { field: "skuQty", source: { kind: "header", header: "SKU发货数量" } },
          { field: "temperatureZone", source: { kind: "header", header: "温层" } },
        ],
      },
    };

    const startedAt = performance.now();
    const result = await parseDocumentWithRule(document, rule);
    const durationMs = performance.now() - startedAt;

    expect(result.rows).toHaveLength(10_000);
    expect(durationMs).toBeLessThan(2_000);
  });
});

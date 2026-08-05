import { describe, expect, it } from "vitest";

import { maskSensitiveValue, validateWorkerRow } from "@/lib/server/import-worker";
import { makeBlankShipmentRow, validateShipmentRows } from "@/lib/validation";

describe("import worker validation", () => {
  it("accepts store delivery mode with valid SKU fields", () => {
    const row = makeBlankShipmentRow({ storeName: "门店 A", skuCode: "SKU_00001", skuName: "商品", skuQty: "2", temperatureZone: "冷藏" });
    expect(validateWorkerRow(row, 1)).toEqual([]);
  });

  it("returns precise phone and quantity errors", () => {
    const row = makeBlankShipmentRow({ recipientName: "张三", recipientPhone: "123", recipientAddress: "上海市", skuCode: "SKU_00001", skuName: "商品", skuQty: "0", temperatureZone: "常温" });
    const issues = validateWorkerRow(row, 7);
    expect(issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(["recipientPhone", "skuQty"]));
    expect(issues.every((issue) => issue.rowIndex === 7)).toBe(true);
  });
});

describe("sensitive value masking", () => {
  it("masks phone and address values", () => {
    expect(maskSensitiveValue("recipientPhone", "13812345678")).toBe("138****5678");
    expect(maskSensitiveValue("recipientAddress", "上海市浦东新区世纪大道100号")).toContain("***");
  });
});

describe("external code aggregation validation", () => {
  it("allows multiple SKU rows to share one receiver under the same external code", () => {
    const first = makeBlankShipmentRow({ externalCode: "ORDER-1", storeName: "门店 A", skuCode: "SKU-1", skuName: "商品一", skuQty: "1", temperatureZone: "常温" });
    const second = makeBlankShipmentRow({ externalCode: "ORDER-1", storeName: "门店 A", skuCode: "SKU-2", skuName: "商品二", skuQty: "2", temperatureZone: "常温" });
    const issues = validateShipmentRows([first, second]);
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(issues.filter((issue) => issue.field === "externalCode" && issue.severity === "warning")).toHaveLength(2);
  });

  it("rejects different receivers under the same external code", () => {
    const first = makeBlankShipmentRow({ externalCode: "ORDER-2", storeName: "门店 A", skuCode: "SKU-1", skuName: "商品一", skuQty: "1", temperatureZone: "常温" });
    const second = makeBlankShipmentRow({ externalCode: "ORDER-2", storeName: "门店 B", skuCode: "SKU-2", skuName: "商品二", skuQty: "2", temperatureZone: "常温" });
    const issues = validateShipmentRows([first, second]);
    expect(issues.filter((issue) => issue.field === "externalCode" && issue.severity === "error")).toHaveLength(2);
  });
});

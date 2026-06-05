import { FIELD_LABELS, TEMPERATURE_OPTIONS } from "@/lib/constants";
import type { RowIssue, ShipmentOrder, ShipmentRow } from "@/lib/types";

export function makeBlankShipmentRow(overrides: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: overrides.id ?? `row-${Math.random().toString(36).slice(2, 10)}`,
    externalCode: "",
    storeName: "",
    recipientName: "",
    recipientPhone: "",
    recipientAddress: "",
    skuCode: "",
    skuName: "",
    skuQty: "",
    skuSpec: "",
    temperatureZone: "",
    remark: "",
    ...overrides,
  };
}

export function validateShipmentRows(rows: ShipmentRow[], existingExternalCodes: string[] = []) {
  const issues: RowIssue[] = [];
  const trimmedExisting = new Set(
    existingExternalCodes.map((item) => item.trim()).filter(Boolean),
  );
  const batchDuplicateMap = new Map<string, Array<{ rowNo: number; row: ShipmentRow }>>();

  rows.forEach((row, index) => {
    const rowNo = index + 1;
    const hasStore = row.storeName.trim().length > 0;
    const recipientFields = {
      recipientName: row.recipientName.trim().length > 0,
      recipientPhone: row.recipientPhone.trim().length > 0,
      recipientAddress: row.recipientAddress.trim().length > 0,
    };
    const recipientFilledCount = Object.values(recipientFields).filter(Boolean).length;
    const hasRecipientBundle = recipientFilledCount === 3;

    if (!hasStore && !hasRecipientBundle) {
      issues.push({
        rowId: row.id,
        rowIndex: rowNo,
        field: "row",
        severity: "error",
        message: "收货门店，或收件人姓名 + 电话 + 地址，至少填一组。",
      });

      if (recipientFilledCount > 0) {
        if (!recipientFields.recipientName) {
          issues.push(issue(row.id, rowNo, "recipientName", "收件人模式下必须填写"));
        }
        if (!recipientFields.recipientPhone) {
          issues.push(issue(row.id, rowNo, "recipientPhone", "收件人模式下必须填写"));
        }
        if (!recipientFields.recipientAddress) {
          issues.push(issue(row.id, rowNo, "recipientAddress", "收件人模式下必须填写"));
        }
      }
    }

    if (!row.skuCode.trim()) {
      issues.push(issue(row.id, rowNo, "skuCode", "不能为空"));
    }

    if (!row.skuName.trim()) {
      issues.push(issue(row.id, rowNo, "skuName", "不能为空"));
    }

    const qty = Number(row.skuQty);
    if (!row.skuQty.trim()) {
      issues.push(issue(row.id, rowNo, "skuQty", "不能为空"));
    } else if (!Number.isFinite(qty) || qty <= 0) {
      issues.push(issue(row.id, rowNo, "skuQty", "必须是正数"));
    }

    if (row.recipientPhone.trim() && !isValidChinaPhone(row.recipientPhone.trim())) {
      issues.push(issue(row.id, rowNo, "recipientPhone", "电话格式不合法"));
    }

    if (!row.temperatureZone.trim()) {
      issues.push(issue(row.id, rowNo, "temperatureZone", "不能为空"));
    }

    if (
      row.temperatureZone.trim() &&
      !TEMPERATURE_OPTIONS.includes(row.temperatureZone.trim())
    ) {
      issues.push(issue(row.id, rowNo, "temperatureZone", "温层需为常温 / 冷藏 / 冷冻 / 恒温"));
    }

    if (row.externalCode.trim()) {
      const key = row.externalCode.trim();
      const items = batchDuplicateMap.get(key) ?? [];
      items.push({ rowNo, row });
      batchDuplicateMap.set(key, items);

      if (trimmedExisting.has(key)) {
        issues.push(issue(row.id, rowNo, "externalCode", "与历史导入数据重复"));
      }
    }
  });

  for (const [externalCode, items] of batchDuplicateMap.entries()) {
    if (items.length < 2) {
      continue;
    }

    const receiverSignatures = new Set(
      items.map(({ row }) =>
        [row.storeName.trim(), row.recipientName.trim(), row.recipientPhone.trim(), row.recipientAddress.trim()].join("|"),
      ),
    );

    items.forEach(({ rowNo, row }) => {
      const peerRows = items.map((item) => item.rowNo).filter((value) => value !== rowNo);
      if (receiverSignatures.size > 1) {
        issues.push(
          issue(
            row.id,
            rowNo,
            "externalCode",
            `同一外部编码对应了多组收货信息，请检查与第 ${peerRows.join("、")} 行的聚合关系（${externalCode}）`,
          ),
        );
      } else {
        issues.push({
          rowId: row.id,
          rowIndex: rowNo,
          field: "externalCode",
          severity: "warning",
          message: `同一外部编码会聚合为一个出库单，关联第 ${peerRows.join("、")} 行（${externalCode}）`,
        });
      }
    });
  }

  return issues.sort((left, right) => left.rowIndex - right.rowIndex);
}

export function groupShipmentRows(rows: ShipmentRow[]): ShipmentOrder[] {
  const grouped = new Map<string, ShipmentRow[]>();

  rows.forEach((row) => {
    const key = row.externalCode.trim() || `未编码-${row.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  });

  return Array.from(grouped.entries()).map(([externalCode, items]) => {
    const first = items[0] ?? makeBlankShipmentRow();
    return {
      id: `order-${externalCode}`,
      externalCode: first.externalCode.trim(),
      storeName: first.storeName,
      recipientName: first.recipientName,
      recipientPhone: first.recipientPhone,
      recipientAddress: first.recipientAddress,
      skuCount: items.length,
      totalQty: items.reduce((sum, row) => {
        const qty = Number(row.skuQty);
        return Number.isFinite(qty) ? sum + qty : sum;
      }, 0),
      rowIds: items.map((row) => row.id),
      createdAt: first.createdAt,
    };
  });
}

function issue(rowId: string, rowIndex: number, field: keyof typeof FIELD_LABELS, message: string): RowIssue {
  return {
    rowId,
    rowIndex,
    field,
    severity: "error",
    message,
  };
}

function isValidChinaPhone(value: string) {
  const normalized = value.replace(/[\s()-]/g, "");
  return /^(?:1[3-9]\d{9}|0\d{2,3}\d{7,8}|\d{7,8})$/.test(normalized);
}

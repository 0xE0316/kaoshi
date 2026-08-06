import type { ImportBatchCreatedEvent, ImportErrorCode, ImportParseEventEnvelope, ImportTaskError } from "@/lib/async-import-types";
import { parseDocumentWithRule } from "@/lib/rule-engine";
import { addLifecycleTrace, batchSkuLookup, claimBatch, claimFileParse, completeBatch, currentTaskOrderReceivers, existingExternalCodes, failBatch, failFileParse, getImportSource, getStagedRows, stageParsedRows } from "@/lib/server/async-import-storage";
import { normalizeUploadedDocument } from "@/lib/server/document-parser";
import { parseStructuredRowsWithKimi } from "@/lib/server/kimi";
import { getRule } from "@/lib/server/storage";
import type { RowIssue, ShipmentField, ShipmentRow } from "@/lib/types";
import { validateShipmentRows } from "@/lib/validation";

export async function processImportFile(event: ImportParseEventEnvelope) {
  const taskId = event.payload.task_id;
  if (!await claimFileParse(taskId)) return { staged: 0, duplicate: true };
  try {
    const source = await getImportSource(taskId);
    if (!source) throw new Error("导入任务源文件不存在");
    const rule = await getRule(String(source.rule_id));
    if (!rule) throw new Error("解析规则不存在或已删除");
    const parseStarted = Date.now();
    const document = await normalizeUploadedDocument({
      buffer: Buffer.from(String(source.file_data), "base64"),
      fileName: String(source.file_name),
      mimeType: String(source.content_type),
    });
    const parseDurationMs = Date.now() - parseStarted;
    const ruleStarted = Date.now();
    const parsed = await parseDocumentWithRule(document, rule, {
      runLlmStructuredParse: (doc, currentRule) => parseStructuredRowsWithKimi({ document: doc, rule: currentRule }),
    });
    const confirmedRows = Array.isArray(source.confirmed_rows) ? source.confirmed_rows as ShipmentRow[] : null;
    return stageParsedRows(taskId, event.trace_id, confirmedRows?.length ? confirmedRows : parsed.rows, { parseDurationMs, ruleDurationMs: Date.now() - ruleStarted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "文件解析失败";
    await failFileParse(taskId, event.trace_id, message);
    throw error;
  }
}

export async function processImportBatch(event: ImportBatchCreatedEvent) {
  const { task_id: taskId, unit_id: unitId, batch_index: batchIndex, start_row: startRow, end_row: endRow } = event.payload;
  const totalStarted = Date.now();
  const claimed = await claimBatch(taskId, unitId);
  if (!claimed) return { status: "already_claimed_or_completed" as const };
  await addLifecycleTrace({
    eventType: "ImportBatchStarted",
    taskId,
    traceId: event.trace_id,
    unitId,
    payload: { task_id: taskId, unit_id: unitId, batch_index: batchIndex, retry_count: claimed.retryCount },
    status: "info",
    message: `批次 ${batchIndex} 开始处理`,
  });

  try {
    const source = await getImportSource(taskId);
    if (!source) throw new Error("导入任务源文件不存在");
    const rows = await getStagedRows(taskId, startRow, endRow);
    if (!rows.length) throw new Error("批次暂存数据不存在，解析事件可能尚未完成");
    let degraded = false;
    let degradedReason: string | undefined;
    let knownSkus = new Set<string>();
    const validateStarted = Date.now();
    try {
      knownSkus = await batchSkuLookup(rows.map((item) => item.row.skuCode));
    } catch (error) {
      degraded = true;
      degradedReason = error instanceof Error ? error.message : "SKU 主数据查询失败";
    }
    const historyCodes = await existingExternalCodes(rows.map((item) => item.row.externalCode), taskId);
    const currentTaskReceivers = await currentTaskOrderReceivers(taskId, rows.map((item) => item.row.externalCode));
    const errors: Omit<ImportTaskError, "id" | "createdAt">[] = [];
    const localRows = rows.map((item) => item.row);
    const rowById = new Map(rows.map((item) => [item.row.id, item]));
    for (const issue of validateShipmentRows(localRows, Array.from(historyCodes))) {
      if (issue.severity !== "error") continue;
      const item = rowById.get(issue.rowId);
      if (!item) continue;
      errors.push(toTaskError({ taskId, unitId, batchIndex, row: item.row, rowNumber: item.rowNumber, issue, traceId: event.trace_id, ruleId: String(source.rule_id) }));
    }
    for (const item of rows) {
      const storedReceiver = currentTaskReceivers.get(item.row.externalCode.trim());
      const incomingReceiver = [item.row.storeName, item.row.recipientName, item.row.recipientPhone, item.row.recipientAddress].map((value) => value.trim()).join("|");
      if (storedReceiver && storedReceiver !== incomingReceiver) {
        errors.push(errorRecord(taskId, unitId, batchIndex, item.rowNumber, "externalCode", item.row.externalCode, "E005", "同一外部编码对应了多组收货信息", "请统一该出库单所有 SKU 行的收货信息", String(source.rule_id), event.trace_id));
      }
      if (!degraded && item.row.skuCode && !knownSkus.has(item.row.skuCode)) {
        errors.push(errorRecord(taskId, unitId, batchIndex, item.rowNumber, "skuCode", item.row.skuCode, "E001", "SKU 主数据中不存在该编码", "请确认 SKU 编码或先维护商品主数据", String(source.rule_id), event.trace_id));
      }
      if (degraded) {
        errors.push(errorRecord(taskId, unitId, batchIndex, item.rowNumber, "skuCode", item.row.skuCode, "E009", "SKU 校验已降级，本行未经过商品主数据完整校验", "服务恢复后执行补校验", String(source.rule_id), event.trace_id));
      }
    }

    const validateDurationMs = Date.now() - validateStarted;
    const blockingCount = new Set(errors.filter((error) => error.errorCode !== "E009").map((error) => error.rowNumber)).size;
    await completeBatch({
      taskId,
      unitId,
      traceId: event.trace_id,
      batchIndex,
      fileName: String(source.file_name),
      ruleId: String(source.rule_id),
      totalRows: Number(source.total_rows),
      rows,
      errors,
      performance: { unitId, batchIndex, parseDurationMs: Number(source.parse_duration_ms), ruleDurationMs: Number(source.rule_duration_ms), validateDurationMs, insertDurationMs: 0, totalDurationMs: Date.now() - totalStarted },
      degraded, degradedReason,
    });
    return { status: "completed" as const, successRows: rows.length - blockingCount, failedRows: blockingCount, degraded };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker 处理失败";
    await failBatch(taskId, unitId, event.trace_id, message, true);
    throw error;
  }
}

export function validateWorkerRow(row: ShipmentRow, rowNumber: number): RowIssue[] {
  const issues: RowIssue[] = [];
  const required: Array<[ShipmentField, string]> = [["skuCode", "SKU物品编码不能为空"], ["skuName", "SKU物品名称不能为空"], ["temperatureZone", "温层不能为空"]];
  for (const [field, message] of required) if (!row[field].trim()) issues.push({ rowId: row.id, rowIndex: rowNumber, field, message, severity: "error" });
  if (!row.storeName.trim() && !(row.recipientName.trim() && row.recipientPhone.trim() && row.recipientAddress.trim())) issues.push({ rowId: row.id, rowIndex: rowNumber, field: "row", message: "收货门店或完整收件信息至少填一组", severity: "error" });
  if (!Number.isFinite(Number(row.skuQty)) || Number(row.skuQty) <= 0) issues.push({ rowId: row.id, rowIndex: rowNumber, field: "skuQty", message: "数量必须为正数", severity: "error" });
  if (row.recipientPhone.trim() && !/^(?:1[3-9]\d{9}|0\d{2,3}\d{7,8}|\d{7,8})$/.test(row.recipientPhone.replace(/[\s()-]/g, ""))) issues.push({ rowId: row.id, rowIndex: rowNumber, field: "recipientPhone", message: "电话格式不合法", severity: "error" });
  return issues;
}

function toTaskError(input: { taskId: string; unitId: string; batchIndex: number; row: ShipmentRow; rowNumber: number; issue: RowIssue; traceId: string; ruleId: string }) {
  const field = input.issue.field;
  const raw = field === "row" ? "" : input.row[field];
  const code: ImportErrorCode = field === "externalCode" ? "E005" : input.issue.message.includes("电话") ? "E003" : input.issue.message.includes("正数") ? "E004" : "E002";
  return errorRecord(input.taskId, input.unitId, input.batchIndex, input.rowNumber, field, raw, code, input.issue.message, "请按字段规则修正后重新导入", input.ruleId, input.traceId);
}

function errorRecord(taskId: string, unitId: string, batchIndex: number, rowNumber: number, fieldName: ShipmentField | "row", rawValue: string, errorCode: ImportErrorCode, errorReason: string, suggestion: string, ruleId: string, traceId: string): Omit<ImportTaskError, "id" | "createdAt"> {
  return { taskId, unitId, batchIndex, rowNumber, fieldName, rawValue: maskSensitiveValue(fieldName, rawValue), errorCode, errorReason, suggestion, ruleId, traceId };
}

export function maskSensitiveValue(field: string, value: string) {
  if (field === "recipientPhone") return value.replace(/(\d{3})\d+(\d{4})/, "$1****$2");
  if (field === "recipientAddress" && value.length > 8) return `${value.slice(0, 6)}***${value.slice(-2)}`;
  return value.slice(0, 200);
}

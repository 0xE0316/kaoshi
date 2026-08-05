import { createHash } from "node:crypto";

import { after, NextResponse } from "next/server";

import { IMPORT_BATCH_SIZE } from "@/lib/async-import-types";
import type { ImportTask } from "@/lib/async-import-types";
import { createImportTask, findRecentTaskByHash } from "@/lib/server/async-import-storage";
import { dispatchOutbox } from "@/lib/server/import-queue";
import type { ShipmentField, ShipmentRow } from "@/lib/types";
import { makeId } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CONFIRMED_ROWS = 20_000;
const shipmentFields: ShipmentField[] = [
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
];

class RequestValidationError extends Error {}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const form = await request.formData();
    const file = form.get("file");
    const ruleId = String(form.get("ruleId") ?? "").trim();
    const totalRows = parseTotalRows(form.get("totalRows"));
    if (!(file instanceof File)) throw new RequestValidationError("请上传文件");
    if (!ruleId) throw new RequestValidationError("必须手动选择解析规则");
    if (file.size > MAX_FILE_BYTES) throw new RequestValidationError("文件不能超过 25MB");

    const confirmedRows = parseConfirmedRows(form.get("confirmedRows"));
    const buffer = Buffer.from(await file.arrayBuffer());
    const hashBuilder = createHash("sha256").update(buffer);
    if (confirmedRows) hashBuilder.update(JSON.stringify(confirmedRows));
    const hash = hashBuilder.digest("hex");
    const duplicate = await findRecentTaskByHash(hash, ruleId);
    if (duplicate) return NextResponse.json({ ...apiTask(duplicate), duplicate: true });

    if (!isSupportedFile(file.name)) throw new RequestValidationError("仅支持 Excel、Word 和 PDF 文件");
    const expectedRows = confirmedRows?.length ?? totalRows;

    const taskId = makeId("task");
    const traceId = makeId("trace");
    const totalBatches = Math.ceil(expectedRows / IMPORT_BATCH_SIZE);
    const batches = Array.from({ length: totalBatches }, (_, index) => ({
      unitId: `unit_${String(index + 1).padStart(4, "0")}`,
      batchIndex: index + 1,
      startRow: index * IMPORT_BATCH_SIZE + 1,
      endRow: Math.min(expectedRows, (index + 1) * IMPORT_BATCH_SIZE),
    }));
    const task = await createImportTask({
      id: taskId,
      traceId,
      fileName: file.name,
      fileHash: hash,
      contentType: file.type,
      fileData: buffer.toString("base64"),
      confirmedRows,
      ruleId,
      totalRows: expectedRows,
      batches,
    });
    if (!task) throw new Error("异步任务创建后无法读取");

    after(() => dispatchOutbox(new URL(request.url).origin, 1).catch(console.error));
    console.log(JSON.stringify({ level: "info", message: "import_task_created", taskId, traceId, totalRows: expectedRows, totalBatches, durationMs: Date.now() - startedAt }));
    return NextResponse.json({ ...apiTask(task), upload_duration_ms: Date.now() - startedAt }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务创建失败";
    const status = error instanceof RequestValidationError ? 400 : 500;
    console.error(JSON.stringify({ level: "error", message: "import_task_create_failed", error: message, durationMs: Date.now() - startedAt }));
    return NextResponse.json({ error: message }, { status });
  }
}

function parseConfirmedRows(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RequestValidationError("用户确认数据不是合法 JSON");
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > MAX_CONFIRMED_ROWS) {
    throw new RequestValidationError(`用户确认数据必须包含 1-${MAX_CONFIRMED_ROWS} 行`);
  }
  return parsed.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || shipmentFields.some((field) => typeof item[field] !== "string")) {
      throw new RequestValidationError(`用户确认数据第 ${index + 1} 行字段不完整`);
    }
    return item as ShipmentRow;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTotalRows(value: FormDataEntryValue | null) {
  const total = Number(value);
  if (!Number.isInteger(total) || total < 1 || total > MAX_CONFIRMED_ROWS) {
    throw new RequestValidationError(`totalRows 必须是 1-${MAX_CONFIRMED_ROWS} 的整数`);
  }
  return total;
}

function isSupportedFile(fileName: string) {
  return /\.(xlsx?|docx|pdf)$/i.test(fileName);
}

function apiTask(task: ImportTask) {
  return {
    task_id: task.id,
    trace_id: task.traceId,
    status: task.status.toUpperCase(),
    total_rows: task.totalRows,
    total_batches: task.totalBatches,
  };
}

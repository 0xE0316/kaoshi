import { NextResponse } from "next/server";

import type { ImportBatchSummary, ShipmentRow } from "@/lib/types";
import {
  DuplicateExternalCodeError,
  listExistingExternalCodeRefs,
  submitShipmentBatch,
} from "@/lib/server/storage";
import { validateShipmentRows } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    fileName?: string;
    ruleId?: string;
    rows?: ShipmentRow[];
  };

  const rows = payload.rows ?? [];
  const fileName = payload.fileName ?? "未命名文件";
  const ruleId = payload.ruleId ?? "manual";

  if (!rows.length) {
    return NextResponse.json({ error: "没有可提交的数据。" }, { status: 400 });
  }

  const issues = validateShipmentRows(rows, await listExistingExternalCodeRefs());
  const blockingIssues = issues.filter((issue) => issue.severity === "error");
  if (blockingIssues.length) {
    return NextResponse.json({ error: "数据存在校验错误。", issues }, { status: 400 });
  }

  let batch: ImportBatchSummary;
  try {
    batch = await submitShipmentBatch({
      fileName,
      ruleId,
      rows,
    });
  } catch (error) {
    if (error instanceof DuplicateExternalCodeError) {
      return NextResponse.json(
        {
          error: error.message,
          issues: validateShipmentRows(rows, error.externalCodes),
        },
        { status: 409 },
      );
    }

    throw error;
  }

  return NextResponse.json({
    batch,
    summary: {
      successCount: batch.successCount,
      failedCount: batch.failedCount,
    },
  });
}

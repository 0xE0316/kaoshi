import { NextResponse } from "next/server";

import { searchTrace } from "@/lib/server/async-import-storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const params = {
    taskId: textValue(query.get("task_id")),
    traceId: textValue(query.get("trace_id")),
    fileName: textValue(query.get("file_name")),
    batch: integerValue(query.get("batch")),
    rowFrom: integerValue(query.get("row_from")),
    rowTo: integerValue(query.get("row_to")),
    errorCode: textValue(query.get("error_code")),
  };
  if (!Object.values(params).some((value) => value !== undefined)) {
    return NextResponse.json({ error: "至少提供一个 Trace 检索条件" }, { status: 400 });
  }
  if (params.rowFrom !== undefined && params.rowTo !== undefined && params.rowFrom > params.rowTo) {
    return NextResponse.json({ error: "起始行号不能大于结束行号" }, { status: 400 });
  }
  return NextResponse.json(await searchTrace(params));
}

function textValue(value: string | null) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function integerValue(value: string | null) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

import { NextResponse } from "next/server";

import { listShipmentRows } from "@/lib/server/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const result = await listShipmentRows({
    query: searchParams.get("query") ?? undefined,
    recipient: searchParams.get("recipient") ?? undefined,
    dateFrom: searchParams.get("dateFrom") ?? undefined,
    dateTo: searchParams.get("dateTo") ?? undefined,
    page: searchParams.get("page") ? Number(searchParams.get("page")) : undefined,
    pageSize: searchParams.get("pageSize") ? Number(searchParams.get("pageSize")) : undefined,
  });

  return NextResponse.json(result);
}

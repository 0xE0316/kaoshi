import { NextResponse } from "next/server";

import { getDashboardSnapshot } from "@/lib/server/storage";

export const runtime = "nodejs";

export async function GET() {
  const snapshot = await getDashboardSnapshot();
  return NextResponse.json(snapshot);
}

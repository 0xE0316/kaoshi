import { NextResponse } from "next/server";

import { rejectUnauthorizedCron } from "@/lib/server/cron-auth";
import { dispatchOutbox } from "@/lib/server/import-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectUnauthorizedCron(request);
  if (rejection) return rejection;
  return NextResponse.json(await dispatchOutbox(new URL(request.url).origin));
}

export const GET = POST;

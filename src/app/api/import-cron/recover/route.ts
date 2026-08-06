import { NextResponse } from "next/server";

import { recoverStaleBatches } from "@/lib/server/async-import-storage";
import { rejectUnauthorizedCron } from "@/lib/server/cron-auth";
import { dispatchOutbox } from "@/lib/server/import-queue";

export const runtime = "nodejs";

async function recover(request: Request) {
  const rejection = rejectUnauthorizedCron(request);
  if (rejection) return rejection;
  const recovered = await recoverStaleBatches();
  const dispatched = await dispatchOutbox(new URL(request.url).origin);
  return NextResponse.json({ ...recovered, dispatched });
}

export const GET = recover;
export const POST = recover;

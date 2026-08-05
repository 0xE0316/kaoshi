import { NextResponse } from "next/server";
import { monitorSummary } from "@/lib/server/async-import-storage";
export const runtime="nodejs";
export async function GET(){return NextResponse.json(await monitorSummary());}

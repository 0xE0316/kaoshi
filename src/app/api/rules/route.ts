import { NextResponse } from "next/server";

import type { DocumentRule } from "@/lib/types";
import { listRules, saveRule } from "@/lib/server/storage";

export const runtime = "nodejs";

export async function GET() {
  const rules = await listRules();
  return NextResponse.json({ rules });
}

export async function POST(request: Request) {
  const payload = (await request.json()) as { rule?: DocumentRule };
  const rule = payload.rule ?? (payload as unknown as DocumentRule);

  if (!rule?.id || !rule?.name || !rule?.extractor) {
    return NextResponse.json({ error: "规则内容不完整。" }, { status: 400 });
  }

  const savedRule = await saveRule(rule);
  return NextResponse.json({ rule: savedRule });
}

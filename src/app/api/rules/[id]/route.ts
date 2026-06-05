import { NextResponse } from "next/server";

import type { DocumentRule } from "@/lib/types";
import { deleteRule, getRule, saveRule } from "@/lib/server/storage";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const rule = await getRule(id);

  if (!rule) {
    return NextResponse.json({ error: "规则不存在。" }, { status: 404 });
  }

  return NextResponse.json({ rule });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const payload = (await request.json()) as { rule?: DocumentRule };
  const rule = payload.rule ?? (payload as unknown as DocumentRule);

  if (!rule?.name || !rule?.extractor) {
    return NextResponse.json({ error: "规则内容不完整。" }, { status: 400 });
  }

  const savedRule = await saveRule({
    ...rule,
    id,
  });

  return NextResponse.json({ rule: savedRule });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await deleteRule(id);
  return NextResponse.json({ ok: true });
}

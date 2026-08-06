import { NextResponse } from "next/server";

import { parseDocumentWithRule } from "@/lib/rule-engine";
import { normalizeUploadedDocument } from "@/lib/server/document-parser";
import { parseStructuredRowsWithKimi } from "@/lib/server/kimi";
import { getRule, listExistingExternalCodeRefs } from "@/lib/server/storage";
import type { DocumentRule } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  const ruleId = String(formData.get("ruleId") ?? "");
  const ruleJson = String(formData.get("ruleJson") ?? "");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "请先上传文件。" }, { status: 400 });
  }

  let rule: DocumentRule | null = null;

  if (ruleJson.trim()) {
    try {
      rule = JSON.parse(ruleJson) as DocumentRule;
    } catch {
      return NextResponse.json({ error: "规则 JSON 解析失败。" }, { status: 400 });
    }
  } else if (ruleId) {
    rule = await getRule(ruleId);
  }

  if (!rule) {
    return NextResponse.json({ error: "请先选择或创建规则。" }, { status: 400 });
  }

  const document = await normalizeUploadedDocument({
    buffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type,
  });
  const existingExternalCodes = await listExistingExternalCodeRefs();

  try {
    const preview = await parseDocumentWithRule(document, rule, {
      existingExternalCodes,
      runLlmStructuredParse: (currentDocument, currentRule) =>
        parseStructuredRowsWithKimi({
          document: currentDocument,
          rule: currentRule,
        }),
    });
    return NextResponse.json({
      ...preview,
      existingExternalCodes,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "试解析失败。",
        documentSummary: document.summary,
      },
      { status: 500 },
    );
  }
}

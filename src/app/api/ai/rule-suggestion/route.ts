import { NextResponse } from "next/server";

import { parseDocumentWithRule } from "@/lib/rule-engine";
import type { DocumentRule } from "@/lib/types";
import { normalizeUploadedDocument } from "@/lib/server/document-parser";
import { hasKimiCredentials, suggestRuleWithKimi } from "@/lib/server/kimi";
import { buildHeuristicRule } from "@/lib/server/rule-suggestion";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "请先上传文件。" }, { status: 400 });
  }

  const document = await normalizeUploadedDocument({
    buffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type,
  });

  const heuristicRule = await buildHeuristicRule(document);
  let rule: DocumentRule = heuristicRule;
  let provider = "heuristic";
  const notes = [heuristicRule.aiSummary ?? "已生成启发式规则初稿。"];

  if (hasKimiCredentials()) {
    try {
      const aiRule = await suggestRuleWithKimi({
        document,
        heuristicRule,
      });
      const normalizedRule = normalizeSuggestedRule(aiRule, heuristicRule);
      rule = await stabilizeSuggestedRule(document, normalizedRule, heuristicRule, notes);
      provider = "kimi";
      notes.unshift("已通过 Kimi 补全字段映射与规则说明。");
    } catch (error) {
      notes.unshift(error instanceof Error ? error.message : "Kimi 规则生成失败，已回退到启发式规则。");
    }
  } else {
    notes.unshift("未配置 KIMI_API_KEY，当前展示的是本地启发式规则。");
  }

  return NextResponse.json({
    rule,
    provider,
    notes,
    documentSummary: document.summary,
  });
}

function normalizeSuggestedRule(rule: DocumentRule, fallback: DocumentRule) {
  return {
    ...fallback,
    ...rule,
    id: fallback.id,
    sourceType: fallback.sourceType,
    sampleFileName: fallback.sampleFileName,
    createdAt: fallback.createdAt,
    updatedAt: new Date().toISOString(),
    extractor: rule.extractor ?? fallback.extractor,
    confidenceNotes: rule.confidenceNotes?.length ? rule.confidenceNotes : fallback.confidenceNotes,
  };
}

async function stabilizeSuggestedRule(
  document: Awaited<ReturnType<typeof normalizeUploadedDocument>>,
  candidate: DocumentRule,
  fallback: DocumentRule,
  notes: string[],
) {
  if (candidate.extractor.kind === "llmStructured" || fallback.extractor.kind === "llmStructured") {
    return candidate;
  }

  try {
    const [candidatePreview, fallbackPreview] = await Promise.all([
      parseDocumentWithRule(document, candidate, { existingExternalCodes: [] }),
      parseDocumentWithRule(document, fallback, { existingExternalCodes: [] }),
    ]);

    if (candidatePreview.rows.length === 0 && fallbackPreview.rows.length > 0) {
      notes.unshift("AI 草稿未产出有效预览，已自动保留启发式规则中的稳定提取器。");
      return {
        ...candidate,
        extractor: fallback.extractor,
        confidenceNotes: candidate.confidenceNotes?.length ? candidate.confidenceNotes : fallback.confidenceNotes,
      };
    }

    return candidate;
  } catch {
    return candidate;
  }
}

import path from "path";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";

import type {
  DocumentSummary,
  NormalizedDocument,
  NormalizedSheet,
  SupportedFileType,
} from "@/lib/types";
import { coerceString } from "@/lib/utils";

let pdfWorkerReady = false;

export async function normalizeUploadedDocument(input: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
}): Promise<NormalizedDocument> {
  const fileType = detectFileType(input.fileName, input.mimeType);

  if (fileType === "excel") {
    return normalizeExcelDocument(input.buffer, input.fileName);
  }

  if (fileType === "pdf") {
    return normalizePdfDocument(input.buffer, input.fileName);
  }

  if (fileType === "word") {
    return normalizeWordDocument(input.buffer, input.fileName);
  }

  return {
    fileName: input.fileName,
    fileType: "unknown",
    fullText: "",
    pages: [],
    sheets: [],
    summary: buildDocumentSummary({
      fileName: input.fileName,
      fileType: "unknown",
      fullText: "",
      pages: [],
      sheets: [],
    }),
  };
}

export function detectFileType(fileName: string, mimeType?: string): SupportedFileType {
  const lowerName = fileName.toLowerCase();
  const lowerType = (mimeType ?? "").toLowerCase();

  if (
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xls") ||
    lowerType.includes("spreadsheet") ||
    lowerType.includes("excel")
  ) {
    return "excel";
  }

  if (lowerName.endsWith(".pdf") || lowerType.includes("pdf")) {
    return "pdf";
  }

  if (
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".doc") ||
    lowerType.includes("word") ||
    lowerType.includes("officedocument.wordprocessingml")
  ) {
    return "word";
  }

  return "unknown";
}

function normalizeExcelDocument(buffer: Buffer, fileName: string): NormalizedDocument {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    dense: false,
    raw: false,
  });

  const sheets: NormalizedSheet[] = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils
      .sheet_to_json<Array<string | number | boolean | null>>(sheet, {
        header: 1,
        raw: false,
        defval: "",
      })
      .map((row) => row.map((cell) => coerceString(cell)));

    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const normalizedRows = rows.map((row) =>
      Array.from({ length: columnCount }, (_, index) => coerceString(row[index] ?? "")),
    );

    return {
      name: sheetName,
      rows: normalizedRows,
      rowCount: normalizedRows.length,
      columnCount,
    };
  });

  const fullText = sheets
    .map((sheet) =>
      sheet.rows
        .map((row) => row.filter(Boolean).join(" | "))
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");

  const pages: string[] = [];
  const summary = buildDocumentSummary({
    fileName,
    fileType: "excel",
    fullText,
    pages,
    sheets,
  });

  return {
    fileName,
    fileType: "excel",
    fullText,
    pages,
    sheets,
    summary,
  };
}

async function normalizePdfDocument(buffer: Buffer, fileName: string): Promise<NormalizedDocument> {
  ensurePdfWorker();
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  const fullText = parsed.text.replace(/\r/g, "").trim();
  const pages = parsed.pages.map((page) => page.text.replace(/\r/g, "").trim()).filter(Boolean);
  await parser.destroy();

  return {
    fileName,
    fileType: "pdf",
    fullText,
    pages,
    sheets: [],
    summary: buildDocumentSummary({
      fileName,
      fileType: "pdf",
      fullText,
      pages,
      sheets: [],
    }),
  };
}

function ensurePdfWorker() {
  if (pdfWorkerReady) {
    return;
  }

  PDFParse.setWorker(path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"));
  pdfWorkerReady = true;
}

async function normalizeWordDocument(buffer: Buffer, fileName: string): Promise<NormalizedDocument> {
  const extracted = await mammoth.extractRawText({ buffer });
  const fullText = extracted.value.replace(/\r/g, "").trim();
  const pages = fullText ? [fullText] : [];

  return {
    fileName,
    fileType: "word",
    fullText,
    pages,
    sheets: [],
    summary: buildDocumentSummary({
      fileName,
      fileType: "word",
      fullText,
      pages,
      sheets: [],
    }),
  };
}

function buildDocumentSummary(input: Omit<NormalizedDocument, "summary">): DocumentSummary {
  const labelCandidates = collectLabelCandidates(input);

  return {
    fileName: input.fileName,
    fileType: input.fileType,
    sheetCount: input.sheets.length,
    pageCount: input.pages.length,
    textPreview: input.fullText.slice(0, 2800),
    labelCandidates,
    sheetPreviews: input.sheets.slice(0, 3).map((sheet) => ({
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      firstRows: sheet.rows.slice(0, 6),
      lastRows: sheet.rows.slice(Math.max(0, sheet.rowCount - 4)),
    })),
  };
}

function collectLabelCandidates(input: Omit<NormalizedDocument, "summary">) {
  const set = new Set<string>();

  for (const sheet of input.sheets) {
    for (const row of sheet.rows.slice(0, 30)) {
      for (const cell of row) {
        const value = cell.trim();
        if (!value) {
          continue;
        }

        if (/[：:]/.test(value) || /收货|电话|地址|单据|备注|联系人/.test(value)) {
          set.add(value);
        }

        if (set.size >= 20) {
          return Array.from(set);
        }
      }
    }
  }

  for (const line of input.fullText.split("\n")) {
    const value = line.trim();
    if (!value) {
      continue;
    }

    if (/[：:]/.test(value) || /收货|电话|地址|单据|备注|联系人/.test(value)) {
      set.add(value);
    }

    if (set.size >= 20) {
      break;
    }
  }

  return Array.from(set);
}

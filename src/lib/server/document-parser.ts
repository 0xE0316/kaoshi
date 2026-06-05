import path from "path";

import mammoth from "mammoth";
import * as XLSX from "xlsx";

import type {
  DocumentSummary,
  NormalizedDocument,
  NormalizedSheet,
  SupportedFileType,
} from "@/lib/types";
import { coerceString } from "@/lib/utils";

let pdfWorkerReady = false;
let pdfParseModulePromise: Promise<typeof import("pdf-parse")> | null = null;

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
  const { PDFParse } = await loadPdfParseModule();
  ensurePdfWorker(PDFParse);
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

async function loadPdfParseModule() {
  if (!pdfParseModulePromise) {
    pdfParseModulePromise = (async () => {
      installPdfDomPolyfills();
      return import("pdf-parse");
    })();
  }

  return pdfParseModulePromise;
}

function installPdfDomPolyfills() {
  const mutableGlobal = globalThis as typeof globalThis & {
    DOMMatrix?: typeof DOMMatrix;
    ImageData?: typeof ImageData;
    Path2D?: typeof Path2D;
  };

  mutableGlobal.DOMMatrix ??= ServerDOMMatrix as unknown as typeof DOMMatrix;
  mutableGlobal.ImageData ??= ServerImageData as unknown as typeof ImageData;
  mutableGlobal.Path2D ??= ServerPath2D as unknown as typeof Path2D;
}

class ServerDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m11 = 1;
  m12 = 0;
  m13 = 0;
  m14 = 0;
  m21 = 0;
  m22 = 1;
  m23 = 0;
  m24 = 0;
  m31 = 0;
  m32 = 0;
  m33 = 1;
  m34 = 0;
  m41 = 0;
  m42 = 0;
  m43 = 0;
  m44 = 1;

  constructor(init?: string | number[]) {
    if (Array.isArray(init) && init.length >= 6) {
      this.a = Number(init[0]) || 1;
      this.b = Number(init[1]) || 0;
      this.c = Number(init[2]) || 0;
      this.d = Number(init[3]) || 1;
      this.e = Number(init[4]) || 0;
      this.f = Number(init[5]) || 0;
      this.syncAliases();
    }
  }

  scaleSelf(scaleX = 1, scaleY = scaleX) {
    this.a *= scaleX;
    this.d *= scaleY;
    this.syncAliases();
    return this;
  }

  translateSelf(tx = 0, ty = 0) {
    this.e += tx;
    this.f += ty;
    this.syncAliases();
    return this;
  }

  multiplySelf() {
    return this;
  }

  preMultiplySelf() {
    return this;
  }

  invertSelf() {
    return this;
  }

  transformPoint(point?: DOMPointInit) {
    const x = point?.x ?? 0;
    const y = point?.y ?? 0;
    return {
      x: this.a * x + this.c * y + this.e,
      y: this.b * x + this.d * y + this.f,
      z: point?.z ?? 0,
      w: point?.w ?? 1,
    };
  }

  toFloat32Array() {
    return Float32Array.from(this.toArray());
  }

  toFloat64Array() {
    return Float64Array.from(this.toArray());
  }

  private syncAliases() {
    this.m11 = this.a;
    this.m12 = this.b;
    this.m21 = this.c;
    this.m22 = this.d;
    this.m41 = this.e;
    this.m42 = this.f;
  }

  private toArray() {
    return [
      this.m11,
      this.m12,
      this.m13,
      this.m14,
      this.m21,
      this.m22,
      this.m23,
      this.m24,
      this.m31,
      this.m32,
      this.m33,
      this.m34,
      this.m41,
      this.m42,
      this.m43,
      this.m44,
    ];
  }
}

class ServerImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace = "srgb";

  constructor(data: Uint8ClampedArray, width: number, height?: number) {
    this.data = data;
    this.width = width;
    this.height = height ?? Math.max(1, Math.floor(data.length / 4 / Math.max(1, width)));
  }
}

class ServerPath2D {
  constructor(path?: Path2D | string) {
    void path;
  }
}

function ensurePdfWorker(PDFParse: typeof import("pdf-parse").PDFParse) {
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

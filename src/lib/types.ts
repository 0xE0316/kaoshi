export type SupportedFileType = "excel" | "pdf" | "word" | "unknown";

export type ShipmentField =
  | "externalCode"
  | "storeName"
  | "recipientName"
  | "recipientPhone"
  | "recipientAddress"
  | "skuCode"
  | "skuName"
  | "skuQty"
  | "skuSpec"
  | "temperatureZone"
  | "remark";

export type ValueSource =
  | { kind: "header"; header: string; fallbackHeaders?: string[] }
  | { kind: "columnIndex"; columnIndex: number }
  | { kind: "label"; label: string; direction?: "right" | "down"; occurrence?: number }
  | { kind: "cell"; row: number; column: number }
  | { kind: "regex"; pattern: string; group?: number; flags?: string }
  | { kind: "static"; value: string }
  | { kind: "dynamicHeader" };

export type FieldTransform =
  | { kind: "trim" }
  | { kind: "numberString" }
  | { kind: "replace"; search: string; replacement: string; flags?: string }
  | { kind: "prepend"; value: string }
  | { kind: "append"; value: string };

export type FieldMapping = {
  field: ShipmentField;
  source: ValueSource;
  transforms?: FieldTransform[];
  uncertain?: boolean;
  note?: string;
};

export type RegexFieldPattern = {
  field: ShipmentField;
  pattern: string;
  group?: number;
  flags?: string;
  defaultValue?: string;
  uncertain?: boolean;
  note?: string;
  sectionScope?: "document" | "section";
};

export type RowGroupMap = Partial<Record<ShipmentField, string>>;

export type SheetSelector =
  | { mode: "first" }
  | { mode: "all" }
  | { mode: "nameIncludes"; value: string };

export type StopCondition =
  | { kind: "firstCellEquals"; value: string }
  | { kind: "rowIncludes"; value: string }
  | { kind: "emptyRow"; minEmptyCells?: number };

export type RowFilter =
  | { kind: "notEmpty"; source: ValueSource }
  | { kind: "notEquals"; source: ValueSource; value: string }
  | { kind: "numberGreaterThan"; source: ValueSource; value: number }
  | { kind: "regexNotMatch"; source: ValueSource; pattern: string; flags?: string };

export type FieldDefault = {
  field: ShipmentField;
  value: string;
};

export type TabularExtractor = {
  kind: "tabular";
  sheetSelector: SheetSelector;
  headerRow: number;
  dataStartRow: number;
  fieldMappings: FieldMapping[];
  sharedMappings?: FieldMapping[];
  stopConditions?: StopCondition[];
  rowFilters?: RowFilter[];
  defaults?: FieldDefault[];
};

export type MatrixColumnsExtractor = {
  kind: "matrixColumns";
  sheetSelector: SheetSelector;
  headerRow: number;
  dataStartRow: number;
  dynamicColumnStart: number;
  dynamicColumnEnd?: number;
  dynamicStopHeaders?: string[];
  fixedMappings: FieldMapping[];
  sharedMappings?: FieldMapping[];
  dynamicHeaderField: ShipmentField;
  dynamicValueField: ShipmentField;
  stopConditions?: StopCondition[];
  skipZero?: boolean;
  cellItemPattern?: string;
  cellItemFlags?: string;
  cellItemGroupMap?: RowGroupMap;
  defaults?: FieldDefault[];
};

export type CardBlocksExtractor = {
  kind: "cardBlocks";
  sheetSelector: SheetSelector;
  blockStartPattern: string;
  blockStartFlags?: string;
  metaMappings: FieldMapping[];
  tableHeaderPattern: string;
  tableHeaderFlags?: string;
  fieldMappings: FieldMapping[];
  stopConditions?: StopCondition[];
  defaults?: FieldDefault[];
};

export type TextBlocksExtractor = {
  kind: "textBlocks";
  blockSplitterPattern: string;
  blockSplitterFlags?: string;
  fieldPatterns: RegexFieldPattern[];
  itemPattern: string;
  itemPatternFlags?: string;
  itemGroupMap?: RowGroupMap;
  defaults?: FieldDefault[];
};

export type TextTableExtractor = {
  kind: "textTable";
  sectionSplitterPattern?: string;
  sectionSplitterFlags?: string;
  fieldPatterns: RegexFieldPattern[];
  tableHeaderPattern: string;
  tableHeaderFlags?: string;
  stopPattern?: string;
  stopFlags?: string;
  rowStartPattern?: string;
  rowStartFlags?: string;
  rowPattern: string;
  rowPatternFlags?: string;
  rowGroupMap?: RowGroupMap;
  continuationMode?: "append-to-previous";
  defaults?: FieldDefault[];
};

export type LlmStructuredExtractor = {
  kind: "llmStructured";
  instruction: string;
  extractionTarget?: "fullText" | "documentSummary";
  defaults?: FieldDefault[];
};

export type RuleExtractor =
  | TabularExtractor
  | MatrixColumnsExtractor
  | CardBlocksExtractor
  | TextBlocksExtractor
  | TextTableExtractor
  | LlmStructuredExtractor;

export type RuleConfidenceNote = {
  field?: ShipmentField | "extractor";
  message: string;
  level: "guess" | "confirmed";
};

export type DocumentRule = {
  id: string;
  name: string;
  description: string;
  sourceType: SupportedFileType | "mixed";
  extractor: RuleExtractor;
  createdAt: string;
  updatedAt: string;
  isTemplate?: boolean;
  sampleFileName?: string;
  aiSummary?: string;
  confidenceNotes?: RuleConfidenceNote[];
};

export type ShipmentRow = Record<ShipmentField, string> & {
  id: string;
  sourceFileName?: string;
  ruleId?: string;
  batchId?: string;
  createdAt?: string;
};

export type ShipmentOrder = {
  id: string;
  externalCode: string;
  storeName: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  skuCount: number;
  totalQty: number;
  rowIds: string[];
  createdAt?: string;
};

export type RowIssue = {
  rowId: string;
  rowIndex: number;
  field: ShipmentField | "row";
  message: string;
  severity: "error" | "warning";
};

export type NormalizedSheet = {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
};

export type DocumentSummary = {
  fileName: string;
  fileType: SupportedFileType;
  sheetCount: number;
  pageCount: number;
  textPreview: string;
  labelCandidates: string[];
  sheetPreviews: Array<{
    name: string;
    rowCount: number;
    columnCount: number;
    firstRows: string[][];
    lastRows: string[][];
  }>;
};

export type NormalizedDocument = {
  fileName: string;
  fileType: SupportedFileType;
  fullText: string;
  pages: string[];
  sheets: NormalizedSheet[];
  summary: DocumentSummary;
};

export type ParsePreviewResult = {
  rows: ShipmentRow[];
  issues: RowIssue[];
  notes: string[];
  durationMs: number;
  rule: DocumentRule;
  documentSummary: DocumentSummary;
  existingExternalCodes?: string[];
};

export type ImportBatchSummary = {
  id: string;
  fileName: string;
  ruleId: string;
  rowCount: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
};

export type ShipmentSearchParams = {
  query?: string;
  recipient?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
};

export type ShipmentSearchResult = {
  rows: ShipmentRow[];
  total: number;
  page: number;
  pageSize: number;
  batches: ImportBatchSummary[];
};

export type DashboardSnapshot = {
  ruleCount: number;
  templateCount: number;
  shipmentRowCount: number;
  batchCount: number;
  duplicateExternalCodeCount: number;
  strategyCount: number;
  providerLabel: string;
  lastImportedAt: string | null;
};

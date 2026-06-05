import {
  type CardBlocksExtractor,
  type DocumentRule,
  type FieldDefault,
  type FieldMapping,
  type MatrixColumnsExtractor,
  type NormalizedDocument,
  type NormalizedSheet,
  type ParsePreviewResult,
  type RowFilter,
  type RowGroupMap,
  type ShipmentField,
  type ShipmentRow,
  type StopCondition,
  type TabularExtractor,
  type TextBlocksExtractor,
  type TextTableExtractor,
  type ValueSource,
} from "@/lib/types";
import { coerceString } from "@/lib/utils";
import { makeBlankShipmentRow, validateShipmentRows } from "@/lib/validation";

type ParseOptions = {
  existingExternalCodes?: string[];
  runLlmStructuredParse?: (
    document: NormalizedDocument,
    rule: DocumentRule,
  ) => Promise<{ rows: ShipmentRow[]; notes?: string[] }>;
};

type SheetContext = {
  sheet: NormalizedSheet;
  header?: string[];
  currentRow?: string[];
  rowsScope?: string[][];
  textScope?: string;
  dynamicHeader?: string;
};

export async function parseDocumentWithRule(
  document: NormalizedDocument,
  rule: DocumentRule,
  options: ParseOptions = {},
): Promise<ParsePreviewResult> {
  const startedAt = Date.now();
  const notes = [...(rule.confidenceNotes ?? []).map((item) => `${item.level === "guess" ? "推测" : "确认"}：${item.message}`)];
  let rows: ShipmentRow[] = [];

  switch (rule.extractor.kind) {
    case "tabular":
      rows = parseTabularExtractor(document, rule, rule.extractor);
      break;
    case "matrixColumns":
      rows = parseMatrixColumnsExtractor(document, rule, rule.extractor);
      break;
    case "cardBlocks":
      rows = parseCardBlocksExtractor(document, rule, rule.extractor);
      break;
    case "textBlocks":
      rows = parseTextBlocksExtractor(document, rule, rule.extractor);
      break;
    case "textTable":
      rows = parseTextTableExtractor(document, rule, rule.extractor);
      break;
    case "llmStructured": {
      if (!options.runLlmStructuredParse) {
        throw new Error("当前规则需要 AI 结构化提取，但后端未提供 LLM 解析实现。");
      }

      const llmResult = await options.runLlmStructuredParse(document, rule);
      rows = llmResult.rows;
      notes.push(...(llmResult.notes ?? []));
      break;
    }
  }

  rows = rows
    .map((row) =>
      makeBlankShipmentRow({
        ...row,
        sourceFileName: document.fileName,
        ruleId: rule.id,
      }),
    )
    .filter((row) => Object.values(row).some((value) => typeof value === "string" && value.trim()));

  const issues = validateShipmentRows(rows, options.existingExternalCodes);

  return {
    rows,
    issues,
    notes,
    durationMs: Date.now() - startedAt,
    rule,
    documentSummary: document.summary,
  };
}

function parseTabularExtractor(document: NormalizedDocument, rule: DocumentRule, extractor: TabularExtractor) {
  const results: ShipmentRow[] = [];

  for (const sheet of selectSheets(document, extractor.sheetSelector)) {
    const header = sheet.rows[extractor.headerRow - 1] ?? [];
    const shared = resolveSharedMappings(extractor.sharedMappings, {
      sheet,
      header,
      rowsScope: sheet.rows,
      textScope: joinRows(sheet.rows),
    });

    for (let rowIndex = extractor.dataStartRow - 1; rowIndex < sheet.rows.length; rowIndex += 1) {
      const currentRow = sheet.rows[rowIndex] ?? [];

      if (matchesStopCondition(currentRow, extractor.stopConditions)) {
        break;
      }

      if (!passesRowFilters(currentRow, extractor.rowFilters, { sheet, header, currentRow })) {
        continue;
      }

      const row = applyDefaults(extractor.defaults, {
        ...shared,
        ...resolveFieldMappings(extractor.fieldMappings, {
          sheet,
          header,
          currentRow,
          rowsScope: sheet.rows,
          textScope: joinRows(sheet.rows),
        }),
      });

      if (isMeaningfulShipmentRow(row)) {
        results.push(materializeRow(row, rule));
      }
    }
  }

  return results;
}

function parseMatrixColumnsExtractor(
  document: NormalizedDocument,
  rule: DocumentRule,
  extractor: MatrixColumnsExtractor,
) {
  const results: ShipmentRow[] = [];

  for (const sheet of selectSheets(document, extractor.sheetSelector)) {
    const header = sheet.rows[extractor.headerRow - 1] ?? [];
    const shared = resolveSharedMappings(extractor.sharedMappings, {
      sheet,
      header,
      rowsScope: sheet.rows,
      textScope: joinRows(sheet.rows),
    });

    for (let rowIndex = extractor.dataStartRow - 1; rowIndex < sheet.rows.length; rowIndex += 1) {
      const currentRow = sheet.rows[rowIndex] ?? [];

      if (matchesStopCondition(currentRow, extractor.stopConditions)) {
        break;
      }

      const baseRow = resolveFieldMappings(extractor.fixedMappings, {
        sheet,
        header,
        currentRow,
        rowsScope: sheet.rows,
        textScope: joinRows(sheet.rows),
      });

      const dynamicEnd = extractor.dynamicColumnEnd ?? sheet.columnCount;
      for (let columnIndex = extractor.dynamicColumnStart - 1; columnIndex < dynamicEnd; columnIndex += 1) {
        const dynamicHeader = coerceString(header[columnIndex]);
        if (!dynamicHeader) {
          continue;
        }

        if (extractor.dynamicStopHeaders?.includes(dynamicHeader)) {
          continue;
        }

        const currentValue = coerceString(currentRow[columnIndex]);
        if (!currentValue) {
          continue;
        }

        if (extractor.cellItemPattern) {
          const matches = collectPatternMatches(
            currentValue,
            extractor.cellItemPattern,
            extractor.cellItemFlags,
          );

          for (const match of matches) {
            const row = applyDefaults(extractor.defaults, {
              ...shared,
              ...baseRow,
              [extractor.dynamicHeaderField]: dynamicHeader,
              ...mapNamedGroups(match.groups, extractor.cellItemGroupMap),
            });

            if (isMeaningfulShipmentRow(row)) {
              results.push(materializeRow(row, rule));
            }
          }

          continue;
        }

        if (extractor.skipZero && !Number(currentValue)) {
          continue;
        }

        const row = applyDefaults(extractor.defaults, {
          ...shared,
          ...baseRow,
          [extractor.dynamicHeaderField]: dynamicHeader,
          [extractor.dynamicValueField]: currentValue,
        });

        if (isMeaningfulShipmentRow(row)) {
          results.push(materializeRow(row, rule));
        }
      }
    }
  }

  return results;
}

function parseCardBlocksExtractor(
  document: NormalizedDocument,
  rule: DocumentRule,
  extractor: CardBlocksExtractor,
) {
  const results: ShipmentRow[] = [];
  const startRegex = new RegExp(extractor.blockStartPattern, extractor.blockStartFlags);
  const headerRegex = new RegExp(extractor.tableHeaderPattern, extractor.tableHeaderFlags);

  for (const sheet of selectSheets(document, extractor.sheetSelector)) {
    const blockStarts: number[] = [];

    sheet.rows.forEach((row, index) => {
      if (startRegex.test(joinRow(row))) {
        blockStarts.push(index);
      }
    });

    blockStarts.forEach((blockStart, blockIndex) => {
      const blockEnd = blockStarts[blockIndex + 1] ?? sheet.rows.length;
      const blockRows = sheet.rows.slice(blockStart, blockEnd);
      const headerRowIndex = blockRows.findIndex((row) => headerRegex.test(joinRow(row)));

      if (headerRowIndex < 0) {
        return;
      }

      const header = blockRows[headerRowIndex];
      const shared = resolveSharedMappings(extractor.metaMappings, {
        sheet,
        header,
        rowsScope: blockRows,
        textScope: joinRows(blockRows),
      });

      for (let rowIndex = headerRowIndex + 1; rowIndex < blockRows.length; rowIndex += 1) {
        const currentRow = blockRows[rowIndex];
        if (matchesStopCondition(currentRow, extractor.stopConditions)) {
          break;
        }

        const row = applyDefaults(extractor.defaults, {
          ...shared,
          ...resolveFieldMappings(extractor.fieldMappings, {
            sheet,
            header,
            currentRow,
            rowsScope: blockRows,
            textScope: joinRows(blockRows),
          }),
        });

        if (isMeaningfulShipmentRow(row)) {
          results.push(materializeRow(row, rule));
        }
      }
    });
  }

  return results;
}

function parseTextBlocksExtractor(
  document: NormalizedDocument,
  rule: DocumentRule,
  extractor: TextBlocksExtractor,
) {
  const results: ShipmentRow[] = [];
  const blocks = splitSections(document.fullText, extractor.blockSplitterPattern, extractor.blockSplitterFlags);

  blocks.forEach((block) => {
    const shared = resolveRegexFieldPatterns(block, block, extractor.fieldPatterns);
    const matches = collectPatternMatches(block, extractor.itemPattern, extractor.itemPatternFlags);

    matches.forEach((match) => {
      const row = applyDefaults(extractor.defaults, {
        ...shared,
        ...mapNamedGroups(match.groups, extractor.itemGroupMap),
      });

      if (isMeaningfulShipmentRow(row)) {
        results.push(materializeRow(row, rule));
      }
    });
  });

  return results;
}

function parseTextTableExtractor(
  document: NormalizedDocument,
  rule: DocumentRule,
  extractor: TextTableExtractor,
) {
  const results: ShipmentRow[] = [];
  const sections = extractor.sectionSplitterPattern
    ? splitSections(document.fullText, extractor.sectionSplitterPattern, extractor.sectionSplitterFlags)
    : [document.fullText];
  const headerRegex = new RegExp(extractor.tableHeaderPattern, extractor.tableHeaderFlags);
  const stopRegex = extractor.stopPattern
    ? new RegExp(extractor.stopPattern, extractor.stopFlags)
    : null;
  const rowStartRegex = extractor.rowStartPattern
    ? new RegExp(extractor.rowStartPattern, extractor.rowStartFlags)
    : null;
  const rowRegex = new RegExp(extractor.rowPattern, extractor.rowPatternFlags);

  sections.forEach((section) => {
    const shared = resolveRegexFieldPatterns(section, document.fullText, extractor.fieldPatterns);
    const lines = section
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const headerIndex = lines.findIndex((line) => headerRegex.test(line));
    const firstRowIndex = rowStartRegex
      ? lines.findIndex((line) => rowStartRegex.test(line))
      : -1;

    if (headerIndex < 0) {
      return;
    }

    const dataLines: string[] = [];
    const dataStartIndex = firstRowIndex >= 0 ? firstRowIndex : headerIndex + 1;

    for (let index = dataStartIndex; index < lines.length; index += 1) {
      const line = lines[index];
      if (stopRegex?.test(line)) {
        break;
      }

      if (headerRegex.test(line) || /^第\d+页/.test(line) || /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) {
        continue;
      }

      if (
        extractor.continuationMode === "append-to-previous" &&
        rowStartRegex &&
        !rowStartRegex.test(line) &&
        dataLines.length > 0
      ) {
        dataLines[dataLines.length - 1] = `${dataLines[dataLines.length - 1]} ${line}`.trim();
        continue;
      }

      if (rowStartRegex && !rowStartRegex.test(line)) {
        continue;
      }

      dataLines.push(line);
    }

    dataLines.forEach((line) => {
      const match = rowRegex.exec(line);
      if (!match?.groups) {
        return;
      }

      const row = applyDefaults(extractor.defaults, {
        ...shared,
        ...mapNamedGroups(match.groups, extractor.rowGroupMap),
      });

      if (isMeaningfulShipmentRow(row)) {
        results.push(materializeRow(row, rule));
      }
    });
  });

  return results;
}

function selectSheets(document: NormalizedDocument, selector: TabularExtractor["sheetSelector"]) {
  switch (selector.mode) {
    case "first":
      return document.sheets.length ? [document.sheets[0]] : [];
    case "all":
      return document.sheets;
    case "nameIncludes":
      return document.sheets.filter((sheet) => sheet.name.includes(selector.value));
  }
}

function resolveSharedMappings(mappings: FieldMapping[] | undefined, context: SheetContext) {
  if (!mappings?.length) {
    return {};
  }

  return resolveFieldMappings(mappings, context);
}

function resolveFieldMappings(mappings: FieldMapping[], context: SheetContext) {
  return mappings.reduce<Partial<ShipmentRow>>((accumulator, mapping) => {
    const resolved = resolveValueSource(mapping.source, context);
    accumulator[mapping.field] = applyTransforms(resolved, mapping.transforms);
    return accumulator;
  }, {});
}

function resolveValueSource(source: ValueSource, context: SheetContext) {
  switch (source.kind) {
    case "header": {
      const headers = [source.header, ...(source.fallbackHeaders ?? [])];
      const index = headers
        .map((header) => findHeaderIndex(context.header ?? [], header))
        .find((value) => value >= 0);

      if (index === undefined || index < 0) {
        return "";
      }

      return coerceString(context.currentRow?.[index]);
    }
    case "columnIndex":
      return coerceString(context.currentRow?.[source.columnIndex - 1]);
    case "label":
      return findLabelValue(context.rowsScope ?? context.sheet.rows, source.label, source.direction, source.occurrence);
    case "cell":
      return coerceString(context.sheet.rows[source.row - 1]?.[source.column - 1]);
    case "regex": {
      const text = context.textScope ?? joinRows(context.rowsScope ?? context.sheet.rows);
      const regex = new RegExp(source.pattern, source.flags);
      const match = regex.exec(text);
      return coerceString(match?.[source.group ?? 1] ?? "");
    }
    case "static":
      return source.value;
    case "dynamicHeader":
      return coerceString(context.dynamicHeader);
  }
}

function applyTransforms(value: string, transforms: FieldMapping["transforms"]) {
  return (transforms ?? []).reduce((current, transform) => {
    switch (transform.kind) {
      case "trim":
        return current.trim();
      case "numberString": {
        const numeric = Number(current);
        if (!Number.isFinite(numeric)) {
          return current.trim();
        }

        return String(numeric);
      }
      case "replace":
        return current.replace(new RegExp(transform.search, transform.flags), transform.replacement);
      case "prepend":
        return `${transform.value}${current}`;
      case "append":
        return `${current}${transform.value}`;
    }
  }, value.trim());
}

function matchesStopCondition(currentRow: string[], conditions?: StopCondition[]) {
  if (!conditions?.length) {
    return false;
  }

  return conditions.some((condition) => {
    switch (condition.kind) {
      case "firstCellEquals":
        return coerceString(currentRow[0]) === condition.value;
      case "rowIncludes":
        return joinRow(currentRow).includes(condition.value);
      case "emptyRow": {
        const emptyCount = currentRow.filter((cell) => !cell.trim()).length;
        const threshold = condition.minEmptyCells ?? currentRow.length;
        return emptyCount >= threshold;
      }
    }
  });
}

function passesRowFilters(currentRow: string[], filters: RowFilter[] | undefined, context: SheetContext) {
  if (!filters?.length) {
    return true;
  }

  return filters.every((filter) => {
    const candidate = resolveValueSource(filter.source, context);
    switch (filter.kind) {
      case "notEmpty":
        return Boolean(candidate.trim());
      case "notEquals":
        return candidate.trim() !== filter.value.trim();
      case "numberGreaterThan":
        return Number(candidate) > filter.value;
      case "regexNotMatch":
        return !new RegExp(filter.pattern, filter.flags).test(candidate);
    }
  });
}

function resolveRegexFieldPatterns(sectionText: string, documentText: string, patterns: TextBlocksExtractor["fieldPatterns"]) {
  return patterns.reduce<Partial<ShipmentRow>>((accumulator, pattern) => {
    const targetText = pattern.sectionScope === "document" ? documentText : sectionText;
    const match = new RegExp(pattern.pattern, pattern.flags).exec(targetText);
    accumulator[pattern.field] = coerceString(match?.[pattern.group ?? 1] ?? pattern.defaultValue ?? "");
    return accumulator;
  }, {});
}

function collectPatternMatches(value: string, pattern: string, flags?: string) {
  const normalizedFlags = flags?.includes("g") ? flags : `${flags ?? ""}g`;
  return Array.from(value.matchAll(new RegExp(pattern, normalizedFlags)));
}

function mapNamedGroups(groups: Record<string, string> | undefined, groupMap?: RowGroupMap) {
  if (!groups) {
    return {};
  }

  const mapping = groupMap ?? ({} as RowGroupMap);
  const result: Partial<ShipmentRow> = {};

  for (const field of shipmentFieldNames) {
    const groupName = mapping[field] ?? field;
    if (!(groupName in groups)) {
      continue;
    }
    result[field] = coerceString(groups[groupName]);
  }

  return result;
}

function splitSections(text: string, pattern: string, flags?: string) {
  return text
    .split(new RegExp(pattern, flags))
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyDefaults(defaults: FieldDefault[] | undefined, row: Partial<ShipmentRow>) {
  const nextRow = { ...row };
  (defaults ?? []).forEach((item) => {
    if (!coerceString(nextRow[item.field]).trim()) {
      nextRow[item.field] = item.value;
    }
  });
  return nextRow;
}

function materializeRow(row: Partial<ShipmentRow>, rule: DocumentRule): ShipmentRow {
  return makeBlankShipmentRow({
    ...row,
    ruleId: rule.id,
  });
}

function findHeaderIndex(headerRow: string[], targetHeader: string) {
  const normalizedTarget = normalizeLabel(targetHeader);
  return headerRow.findIndex((cell) => normalizeLabel(cell) === normalizedTarget);
}

function findLabelValue(
  rows: string[][],
  label: string,
  direction: "right" | "down" = "right",
  occurrence = 1,
) {
  const normalizedTarget = normalizeLabel(label);
  let hits = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const currentCell = coerceString(row[columnIndex]);
      const inlineValue = extractInlineLabelValue(currentCell, label);

      if (inlineValue) {
        hits += 1;
        if (hits === occurrence) {
          return inlineValue;
        }
        continue;
      }

      if (normalizeLabel(currentCell) !== normalizedTarget) {
        continue;
      }

      hits += 1;
      if (hits !== occurrence) {
        continue;
      }

      if (direction === "down") {
        for (let nextRow = rowIndex + 1; nextRow < rows.length; nextRow += 1) {
          const candidate = coerceString(rows[nextRow]?.[columnIndex]);
          if (candidate) {
            return candidate;
          }
        }

        return "";
      }

      for (let nextColumn = columnIndex + 1; nextColumn < row.length; nextColumn += 1) {
        const candidate = coerceString(row[nextColumn]);
        if (candidate) {
          return candidate;
        }
      }

      return "";
    }
  }

  return "";
}

function extractInlineLabelValue(cell: string, label: string) {
  const normalizedCell = coerceString(cell);
  const normalizedLabelText = coerceString(label).replace(/[：:\s]+$/g, "");
  if (!normalizedCell || !normalizedLabelText) {
    return "";
  }

  const pattern = new RegExp(`^${escapeRegex(normalizedLabelText)}\\s*[：:]\\s*(.+)$`);
  const match = pattern.exec(normalizedCell);
  return coerceString(match?.[1] ?? "");
}

function normalizeLabel(value: string) {
  return coerceString(value).replace(/[：:\s*＊]/g, "");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function joinRows(rows: string[][]) {
  return rows.map((row) => joinRow(row)).join("\n");
}

function joinRow(row: string[]) {
  return row.map((cell) => cell.trim()).filter(Boolean).join(" ");
}

function isMeaningfulShipmentRow(row: Partial<ShipmentRow>) {
  const keys: ShipmentField[] = ["skuCode", "skuName", "skuQty", "storeName", "recipientName"];
  return keys.some((key) => coerceString(row[key]).trim());
}

const shipmentFieldNames: ShipmentField[] = [
  "externalCode",
  "storeName",
  "recipientName",
  "recipientPhone",
  "recipientAddress",
  "skuCode",
  "skuName",
  "skuQty",
  "skuSpec",
  "temperatureZone",
  "remark",
];

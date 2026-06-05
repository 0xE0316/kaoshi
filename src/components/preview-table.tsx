"use client";

import { useMemo, type KeyboardEvent } from "react";
import { List, type RowComponentProps } from "react-window";
import { Plus, Trash2 } from "lucide-react";

import { FIELD_LABELS, PREVIEW_COLUMNS } from "@/lib/constants";
import type { RowIssue, ShipmentField, ShipmentRow } from "@/lib/types";
import { cn } from "@/lib/utils";

type PreviewTableProps = {
  rows: ShipmentRow[];
  issues: RowIssue[];
  onChange: (rowId: string, field: ShipmentField, value: string) => void;
  onDeleteRow: (rowId: string) => void;
  onAddRow: () => void;
};

type RowData = {
  rows: ShipmentRow[];
  issuesByRow: Map<string, Map<string, "error" | "warning">>;
  onChange: PreviewTableProps["onChange"];
  onDeleteRow: PreviewTableProps["onDeleteRow"];
};

const rowHeight = 72;
const headerHeight = 48;
const rowNumberWidth = 72;
const actionWidth = 74;

export function PreviewTable({
  rows,
  issues,
  onChange,
  onDeleteRow,
  onAddRow,
}: PreviewTableProps) {
  const issuesByRow = useMemo(() => {
    const map = new Map<string, Map<string, "error" | "warning">>();
    issues.forEach((issue) => {
      const rowMap = map.get(issue.rowId) ?? new Map<string, "error" | "warning">();
      const currentSeverity = rowMap.get(issue.field);
      if (currentSeverity !== "error") {
        rowMap.set(issue.field, issue.severity);
      }
      map.set(issue.rowId, rowMap);
    });
    return map;
  }, [issues]);

  const totalWidth =
    PREVIEW_COLUMNS.reduce((sum, column) => sum + column.width, 0) + rowNumberWidth + actionWidth;
  const listHeight = Math.min(680, Math.max(240, rows.length * rowHeight));

  return (
    <section className="overflow-hidden rounded-[18px] border border-[rgba(15,198,194,0.18)] bg-white shadow-[0_12px_40px_rgba(7,67,93,0.08)]">
      <div className="flex items-center justify-between border-b border-[rgba(15,198,194,0.12)] px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">解析结果</h3>
          <p className="mt-1 text-xs text-slate-500">可直接在表里修改、补行或删行，确认后再提交。</p>
        </div>
        <button
          type="button"
          onClick={onAddRow}
          className="inline-flex items-center gap-2 rounded-full border border-[rgba(15,198,194,0.22)] bg-[rgba(15,198,194,0.1)] px-4 py-2 text-xs font-semibold text-[#0f8b99] transition hover:bg-[rgba(15,198,194,0.16)]"
        >
          <Plus className="h-4 w-4" />
          新增一行
        </button>
      </div>

      <div className="overflow-x-auto bg-[linear-gradient(180deg,#f7fcff_0%,#f2f8fb_100%)]">
        <div style={{ minWidth: totalWidth }}>
          <div
            className="grid border-b border-[rgba(15,198,194,0.12)] bg-[#f4fbfc] text-[12px] font-semibold text-slate-600"
            style={{
              gridTemplateColumns: buildTemplateColumns(),
              height: headerHeight,
            }}
          >
            <div className="flex items-center border-r border-[rgba(15,198,194,0.12)] px-4">行号</div>
            {PREVIEW_COLUMNS.map((column) => (
              <div
                key={column.field}
                className="flex items-center border-r border-[rgba(15,198,194,0.12)] px-4"
              >
                {FIELD_LABELS[column.field]}
              </div>
            ))}
            <div className="flex items-center justify-center px-2">操作</div>
          </div>

          <List
            defaultHeight={listHeight}
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowComponent={VirtualRow}
            rowProps={{
              rows,
              issuesByRow,
              onChange,
              onDeleteRow,
            } satisfies RowData}
            style={{ height: listHeight, width: totalWidth }}
          />
        </div>
      </div>
    </section>
  );
}

function VirtualRow({
  index,
  style,
  rows,
  issuesByRow,
  onChange,
  onDeleteRow,
}: RowComponentProps<RowData>) {
  const row = rows[index];
  const fieldIssues = issuesByRow.get(row.id) ?? new Map<string, "error" | "warning">();

  return (
    <div
      style={style}
      className={cn(
        "grid border-b border-[rgba(15,198,194,0.08)] bg-white text-sm",
        index % 2 === 1 && "bg-[rgba(244,251,252,0.45)]",
      )}
      role="row"
      aria-rowindex={index + 1}
    >
      <div
        className="grid h-full"
        style={{
          gridTemplateColumns: buildTemplateColumns(),
        }}
      >
        <div className="flex items-center border-r border-[rgba(15,198,194,0.08)] px-4 text-xs font-semibold text-slate-500">
          #{index + 1}
        </div>

        {PREVIEW_COLUMNS.map((column) => {
          const rowSeverity = fieldIssues.get("row");
          const fieldSeverity = fieldIssues.get(column.field);
          const severity = rowSeverity === "error" ? "error" : fieldSeverity ?? rowSeverity;
          return (
            <div
              key={`${row.id}-${column.field}`}
              className="border-r border-[rgba(15,198,194,0.08)] px-2 py-2"
            >
              <input
                value={row[column.field]}
                onChange={(event) => onChange(row.id, column.field, event.target.value)}
                onKeyDown={(event) => handleCellKeyDown(event, index, PREVIEW_COLUMNS.findIndex((item) => item.field === column.field))}
                data-row-index={index}
                data-column-index={PREVIEW_COLUMNS.findIndex((item) => item.field === column.field)}
                className={cn(
                  "h-full w-full rounded-[12px] border px-3 text-[13px] text-slate-700 outline-none transition placeholder:text-slate-300",
                  severity === "error"
                    ? "border-rose-300 bg-rose-50/70 focus:border-rose-400"
                    : severity === "warning"
                      ? "border-amber-300 bg-amber-50/80 focus:border-amber-400"
                    : "border-transparent bg-[#f8fcfe] focus:border-[rgba(15,198,194,0.36)] focus:bg-white",
                )}
                placeholder={FIELD_LABELS[column.field]}
              />
            </div>
          );
        })}

        <div className="flex items-center justify-center px-2">
          <button
            type="button"
            onClick={() => onDeleteRow(row.id)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-rose-100 bg-rose-50 text-rose-500 transition hover:border-rose-200 hover:bg-rose-100"
            aria-label={`删除第 ${index + 1} 行`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function buildTemplateColumns() {
  return [
    `${rowNumberWidth}px`,
    ...PREVIEW_COLUMNS.map((column) => `${column.width}px`),
    `${actionWidth}px`,
  ].join(" ");
}

function handleCellKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  rowIndex: number,
  columnIndex: number,
) {
  if (event.key !== "Enter" && event.key !== "Tab") {
    return;
  }

  event.preventDefault();

  const moveBackward = event.key === "Tab" && event.shiftKey;
  const lastColumnIndex = PREVIEW_COLUMNS.length - 1;
  let nextRowIndex = rowIndex;
  let nextColumnIndex = columnIndex + (moveBackward ? -1 : 1);

  if (nextColumnIndex > lastColumnIndex) {
    nextColumnIndex = 0;
    nextRowIndex += 1;
  }

  if (nextColumnIndex < 0) {
    nextColumnIndex = lastColumnIndex;
    nextRowIndex -= 1;
  }

  if (nextRowIndex < 0) {
    return;
  }

  requestAnimationFrame(() => {
    const nextInput = document.querySelector<HTMLInputElement>(
      `input[data-row-index="${nextRowIndex}"][data-column-index="${nextColumnIndex}"]`,
    );
    nextInput?.focus();
    nextInput?.select();
  });
}

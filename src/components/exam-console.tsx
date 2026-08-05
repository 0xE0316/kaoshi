"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertCircle,
  Boxes,
  Copy,
  Database,
  FileSpreadsheet,
  FileText,
  LayoutPanelLeft,
  Play,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  WandSparkles,
} from "lucide-react";

import { PreviewTable } from "@/components/preview-table";
import { SystemNav } from "@/components/system-nav";
import { FIELD_LABELS, PREVIEW_COLUMNS, SECTION_ITEMS } from "@/lib/constants";
import type {
  DashboardSnapshot,
  DocumentRule,
  DocumentSummary,
  ExistingExternalCodeRef,
  ParsePreviewResult,
  RowIssue,
  ShipmentField,
  ShipmentOrder,
  ShipmentRow,
  ShipmentSearchResult,
} from "@/lib/types";
import { cn, formatDateTime, makeId, safeJsonParse } from "@/lib/utils";
import { groupShipmentRows, makeBlankShipmentRow, validateShipmentRows } from "@/lib/validation";

type SectionKey = (typeof SECTION_ITEMS)[number]["key"];
type ToastTone = "success" | "error" | "info";

type ToastItem = {
  id: string;
  tone: ToastTone;
  message: string;
};

type SuggestionResponse = {
  rule: DocumentRule;
  provider: string;
  notes: string[];
  documentSummary: DocumentSummary;
};

type ApiErrorPayload = {
  error?: string;
  issues?: RowIssue[];
  documentSummary?: DocumentSummary;
};

class ApiError extends Error {
  readonly payload: ApiErrorPayload;

  constructor(message: string, payload: ApiErrorPayload = {}) {
    super(message);
    this.name = "ApiError";
    this.payload = payload;
  }
}

export function ExamConsole() {
  const [activeSection, setActiveSection] = useState<SectionKey>("import");
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [rules, setRules] = useState<DocumentRule[]>([]);
  const [shipments, setShipments] = useState<ShipmentSearchResult | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyRecipient, setHistoryRecipient] = useState("");
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [loadingApp, setLoadingApp] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [ruleDraftText, setRuleDraftText] = useState("");
  const [documentSummary, setDocumentSummary] = useState<DocumentSummary | null>(null);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<ShipmentRow[]>([]);
  const [parsedPreviewRows, setParsedPreviewRows] = useState<ShipmentRow[]>([]);
  const [previewIssues, setPreviewIssues] = useState<RowIssue[]>([]);
  const [parseProgress, setParseProgress] = useState<{ value: number; label: string } | null>(null);
  const [submitProgress, setSubmitProgress] = useState<{ value: number; label: string } | null>(null);
  const [existingExternalCodes, setExistingExternalCodes] = useState<ExistingExternalCodeRef[]>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoadingApp(true);
      try {
        const [nextDashboard, nextRules, nextShipments] = await Promise.all([
          fetchJson<DashboardSnapshot>("/api/dashboard"),
          fetchJson<{ rules: DocumentRule[] }>("/api/rules"),
          fetchJson<ShipmentSearchResult>("/api/shipments?page=1&pageSize=20"),
        ]);

        if (cancelled) {
          return;
        }

        setDashboard(nextDashboard);
        setRules(nextRules.rules);
        setShipments(nextShipments);
      } catch (error) {
        if (!cancelled) {
          pushToast("error", error instanceof Error ? error.message : "页面加载失败，请刷新后重试。");
        }
      } finally {
        if (!cancelled) {
          setLoadingApp(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const parsedDraftRule = useMemo(() => {
    if (!ruleDraftText.trim()) {
      return null;
    }
    try {
      return JSON.parse(ruleDraftText) as DocumentRule;
    } catch {
      return null;
    }
  }, [ruleDraftText]);

  const currentSectionMeta = SECTION_ITEMS.find((item) => item.key === activeSection);
  const savedRules = rules.filter((rule) => !rule.isTemplate);
  const templateRules = rules.filter((rule) => rule.isTemplate);
  const blockingIssues = previewIssues.filter((issue) => issue.severity === "error");
  const warningIssues = previewIssues.filter((issue) => issue.severity === "warning");
  const hasPreviewErrors = blockingIssues.length > 0;
  const totalPreviewQty = previewRows.reduce((sum, row) => sum + Number(row.skuQty || 0), 0);
  const aggregatedOrders = useMemo(() => groupShipmentRows(previewRows), [previewRows]);
  const visibleRules = activeSection === "rules" ? rules : savedRules;

  async function bootstrap() {
    setLoadingApp(true);
    try {
      await Promise.all([refreshDashboard(), refreshRules(), refreshShipments()]);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "页面刷新失败，请稍后再试。");
    } finally {
      setLoadingApp(false);
    }
  }

  async function refreshDashboard() {
    const data = await fetchJson<DashboardSnapshot>("/api/dashboard");
    setDashboard(data);
  }

  async function refreshRules() {
    const data = await fetchJson<{ rules: DocumentRule[] }>("/api/rules");
    setRules(data.rules);
  }

  async function refreshShipments(page = 1) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "20",
    });
    if (historyQuery.trim()) params.set("query", historyQuery.trim());
    if (historyRecipient.trim()) params.set("recipient", historyRecipient.trim());
    if (historyDateFrom) params.set("dateFrom", historyDateFrom);
    if (historyDateTo) params.set("dateTo", historyDateTo);

    const data = await fetchJson<ShipmentSearchResult>(`/api/shipments?${params.toString()}`);
    setShipments(data);
  }

  function pushToast(tone: ToastTone, message: string) {
    const next = { id: makeId("toast"), tone, message };
    setToasts((current) => [...current, next]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== next.id));
    }, 3800);
  }

  function selectRule(rule: DocumentRule) {
    setSelectedRuleId(rule.id);
    setRuleDraftText(JSON.stringify(rule, null, 2));
    setAiNotes(rule.aiSummary ? [rule.aiSummary] : []);
    setActiveSection("import");
  }

  function applySelectedFile(nextFile: File | null) {
    setSelectedFile(nextFile);
    setPreviewRows([]);
    setParsedPreviewRows([]);
    setPreviewIssues([]);
    setExistingExternalCodes([]);
    if (nextFile) {
      pushToast("success", `已选中文件：${nextFile.name}`);
    }
  }

  function handleCreateRuleDraft() {
    const nextRule = buildBlankRule(selectedFile?.name);
    setSelectedRuleId(nextRule.id);
    setRuleDraftText(JSON.stringify(nextRule, null, 2));
    setAiNotes([]);
    setDocumentSummary(null);
    setPreviewRows([]);
    setParsedPreviewRows([]);
    setPreviewIssues([]);
    setExistingExternalCodes([]);
    pushToast("success", "已新建一份空白规则草稿，可以直接修改或让 AI 继续补全。");
  }

  async function handleGenerateRule() {
    if (!selectedFile) {
      pushToast("info", "先选一个文件，再让 AI 帮你生成规则。");
      return;
    }

    setBusyKey("suggest-rule");
    setParseProgress({ value: 12, label: "正在读取文件" });

    try {
      const formData = new FormData();
      formData.set("file", selectedFile);
      await sleep(180);
      setParseProgress({ value: 38, label: "正在识别表头和内容" });
      const data = await postForm<SuggestionResponse>("/api/ai/rule-suggestion", formData);
      setParseProgress({ value: 84, label: "正在整理推荐规则" });
      setRuleDraftText(JSON.stringify(data.rule, null, 2));
      setSelectedRuleId(data.rule.id);
      setDocumentSummary(data.documentSummary);
      setAiNotes(data.notes);
      pushToast("success", "已生成一版推荐规则，右侧可以继续调整后再保存。");
      setParseProgress({ value: 100, label: "规则建议已生成" });
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "规则生成失败。");
      setParseProgress(null);
    } finally {
      setBusyKey(null);
      window.setTimeout(() => setParseProgress(null), 900);
    }
  }

  async function handleSaveRule() {
    if (!parsedDraftRule) {
      pushToast("error", "规则内容还不完整，先调整后再保存。");
      return;
    }

    setBusyKey("save-rule");
    try {
      const data = await postJson<{ rule: DocumentRule }>("/api/rules", { rule: parsedDraftRule });
      pushToast("success", `规则已保存：${data.rule.name}`);
      setSelectedRuleId(data.rule.id);
      setRuleDraftText(JSON.stringify(data.rule, null, 2));
      await Promise.all([refreshRules(), refreshDashboard()]);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "规则保存失败。");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    setBusyKey(`delete-${ruleId}`);
    try {
      await fetch(`/api/rules/${ruleId}`, { method: "DELETE" }).then(ensureOk);
      pushToast("success", "规则已删除。");
      if (selectedRuleId === ruleId) {
        setSelectedRuleId("");
      }
      await Promise.all([refreshRules(), refreshDashboard()]);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "删除失败。");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDuplicateRule(rule: DocumentRule) {
    const duplicated: DocumentRule = {
      ...safeJsonParse(JSON.stringify(rule), rule),
      id: makeId("rule"),
      name: `${rule.name} · 复制`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setBusyKey(`duplicate-${rule.id}`);
    try {
      await postJson("/api/rules", { rule: duplicated });
      pushToast("success", `已复制规则：${duplicated.name}`);
      await Promise.all([refreshRules(), refreshDashboard()]);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "复制失败。");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleTestParse() {
    if (!selectedFile) {
      pushToast("info", "先上传一个文件，再做试解析。");
      return;
    }

    const candidateRule = parsedDraftRule ?? rules.find((rule) => rule.id === selectedRuleId) ?? null;
    if (!candidateRule) {
      pushToast("info", "请先选择规则，或先新建一条规则。");
      return;
    }

    setBusyKey("preview-parse");
    setParseProgress({ value: 14, label: "正在上传并检查文件" });

    try {
      const formData = new FormData();
      formData.set("file", selectedFile);
      formData.set("ruleJson", JSON.stringify(candidateRule));
      await sleep(150);
      setParseProgress({ value: 44, label: "正在按规则拆分数据" });
      const data = await postForm<ParsePreviewResult>("/api/parse/preview", formData);
      setParseProgress({ value: 86, label: `正在整理预览结果，已处理 ${data.rows.length}/${data.rows.length} 条` });
      setPreviewRows(data.rows);
      setParsedPreviewRows(data.rows);
      setPreviewIssues(data.issues);
      setExistingExternalCodes(data.existingExternalCodes ?? []);
      setDocumentSummary(data.documentSummary);
      setAiNotes(data.notes);
      setParseProgress({ value: 100, label: "试解析完成" });
      pushToast("success", `试解析完成，共得到 ${data.rows.length} 行结果。`);
    } catch (error) {
      if (error instanceof ApiError && error.payload.documentSummary) {
        setDocumentSummary(error.payload.documentSummary);
      }
      pushToast("error", error instanceof Error ? error.message : "试解析失败。");
      setParseProgress(null);
    } finally {
      setBusyKey(null);
      window.setTimeout(() => setParseProgress(null), 900);
    }
  }

  function handlePreviewCellChange(rowId: string, field: ShipmentField, value: string) {
    setPreviewRows((current) => {
      const nextRows = current.map((row) => (row.id === rowId ? { ...row, [field]: value } : row));
      setPreviewIssues(validateShipmentRows(nextRows, existingExternalCodes));
      return nextRows;
    });
  }

  function handleDeletePreviewRow(rowId: string) {
    setPreviewRows((current) => {
      const nextRows = current.filter((row) => row.id !== rowId);
      setPreviewIssues(validateShipmentRows(nextRows, existingExternalCodes));
      return nextRows;
    });
  }

  function handleAddPreviewRow() {
    setPreviewRows((current) => {
      const nextRows = [...current, makeBlankShipmentRow()];
      setPreviewIssues(validateShipmentRows(nextRows, existingExternalCodes));
      return nextRows;
    });
  }

  function handleExportPreview() {
    if (!previewRows.length) {
      pushToast("info", "还没有可导出的结果。");
      return;
    }

    const exportRows = previewRows.map((row) => {
      const output: Record<string, string> = {};
      PREVIEW_COLUMNS.forEach((column) => {
        output[FIELD_LABELS[column.field]] = row[column.field];
      });
      return output;
    });

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(exportRows);
    XLSX.utils.book_append_sheet(workbook, sheet, "预览结果");
    XLSX.writeFile(workbook, `${stripExtension(selectedFile?.name ?? "preview")}-preview.xlsx`);
    pushToast("success", "已导出当前结果。");
  }

  async function handleSubmitPreview() {
    if (!previewRows.length) {
      pushToast("info", "先完成试解析，再提交下单。");
      return;
    }

    if (blockingIssues.length) {
      pushToast("error", "还有未处理的错误，请先把红色项修正完。");
      return;
    }

    const currentRule = parsedDraftRule ?? rules.find((rule) => rule.id === selectedRuleId);
    setBusyKey("submit-preview");
    setSubmitProgress({ value: 18, label: "正在检查并去重" });

    try {
      if (!selectedFile || !currentRule?.id) throw new Error("异步导入需要原始文件和已保存规则。");
      if (!rules.some((rule) => rule.id === currentRule.id)) throw new Error("正式提交前请先保存当前规则草稿。");
      const formData = new FormData();
      formData.set("file", selectedFile);
      formData.set("ruleId", currentRule.id);
      formData.set("totalRows", String(previewRows.length));
      if (JSON.stringify(previewRows) !== JSON.stringify(parsedPreviewRows)) {
        formData.set("confirmedRows", JSON.stringify(previewRows));
      }
      setSubmitProgress({ value: 42, label: "正在创建异步任务" });
      const data = await postForm<{ task_id: string; trace_id: string }>("/api/import-tasks", formData);
      setSubmitProgress({ value: 100, label: "任务已创建" });
      pushToast("success", `异步任务已创建：${data.task_id}`);
      window.location.assign(`/monitor?task_id=${encodeURIComponent(data.task_id)}`);
    } catch (error) {
      if (error instanceof ApiError && error.payload.issues?.length) {
        setPreviewIssues(error.payload.issues);
      }
      pushToast("error", error instanceof Error ? error.message : "提交失败。");
      setSubmitProgress(null);
    } finally {
      setBusyKey(null);
      window.setTimeout(() => setSubmitProgress(null), 1200);
    }
  }

  async function handleHistorySearch(page = 1) {
    setBusyKey("history-search");
    try {
      await refreshShipments(page);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "查询历史失败。");
    } finally {
      setBusyKey(null);
    }
  }

  if (loadingApp) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[var(--shell-bg)]">
        <div className="rounded-[24px] border border-[rgba(15,198,194,0.16)] bg-white px-8 py-6 text-sm text-slate-500 shadow-[0_20px_70px_rgba(7,67,93,0.12)]">
          正在打开导入工作台...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--shell-bg)] text-slate-900">
      <ToastStack items={toasts} />

      <main className="flex min-h-screen w-full flex-col px-3 py-3 lg:px-4">
        <div className="flex min-h-[calc(100dvh-24px)] flex-1 flex-col">
          <div className="flex min-h-full flex-1 flex-col rounded-[30px] border border-white/70 bg-white/78 p-3 shadow-[0_18px_60px_rgba(8,66,88,0.1)] backdrop-blur">
            <div className="rounded-[24px] border border-[rgba(15,198,194,0.12)] bg-[linear-gradient(180deg,#f7fcfe_0%,#eff8fc_100%)] px-5 py-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div className="max-w-4xl">
                  <div className="text-sm font-semibold text-[#0f8b99]">智能多格式批量下单系统</div>
                  <h1 className="mt-2 text-[28px] font-semibold tracking-normal text-slate-900">多格式批量下单工作台</h1>
                  <p className="mt-2 text-sm leading-7 text-slate-500">
                    把客户给来的 Excel、Word、PDF 整理成可下单数据。先选规则试解析，确认无误后再提交。
                  </p>
                </div>
                <div className="flex flex-col items-start gap-2 text-xs text-slate-500 xl:items-end">
                  <SystemNav current="import" />
                  <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-[rgba(15,198,194,0.16)] bg-white px-3 py-1.5 font-semibold text-slate-700">
                    当前区域：{currentSectionMeta?.label}
                  </span>
                  <span className="rounded-full bg-white/80 px-3 py-1.5">{currentSectionMeta?.helper}</span></div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 rounded-[20px] border border-[rgba(15,198,194,0.12)] bg-[#f6fbfe] p-2">
              {SECTION_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveSection(item.key)}
                  className={cn(
                    "rounded-[14px] px-4 py-2.5 text-sm font-semibold transition",
                    activeSection === item.key
                      ? "bg-[linear-gradient(90deg,#11cac7_0%,#109ec4_100%)] text-white shadow-[0_10px_25px_rgba(15,168,194,0.25)]"
                      : "bg-white text-slate-500 hover:text-slate-900",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <section className="mt-4">
              {activeSection === "dashboard" && (
                <DashboardSection dashboard={dashboard} onRefresh={bootstrap} busy={busyKey === "dashboard-refresh"} />
              )}

              {activeSection === "import" && (
                <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)] 2xl:grid-cols-[420px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <Panel
                      title="文件导入"
                      description="先把客户文件放进来，支持拖拽和点击选择。"
                      icon={<UploadCloud className="h-4 w-4" />}
                    >
                      <label
                        className={cn(
                          "block cursor-pointer rounded-[18px] border border-dashed px-4 py-6 text-center transition",
                          isFileDragOver
                            ? "border-[rgba(15,198,194,0.52)] bg-[rgba(15,198,194,0.14)] shadow-[0_0_0_4px_rgba(15,198,194,0.08)]"
                            : "border-[rgba(15,198,194,0.36)] bg-[rgba(15,198,194,0.08)] hover:bg-[rgba(15,198,194,0.12)]",
                        )}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setIsFileDragOver(true);
                        }}
                        onDragLeave={() => setIsFileDragOver(false)}
                        onDrop={(event) => {
                          event.preventDefault();
                          setIsFileDragOver(false);
                          applySelectedFile(event.dataTransfer.files?.[0] ?? null);
                        }}
                      >
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#0f8b99] shadow-sm">
                          <FileSpreadsheet className="h-5 w-5" />
                        </div>
                        <div className="mt-3 text-sm font-semibold text-slate-800">拖拽到这里，或点击选择文件</div>
                        <div className="mt-1 text-xs text-slate-500">支持 .xlsx / .xls / .docx / .pdf</div>
                        <input
                          type="file"
                          accept=".xlsx,.xls,.docx,.pdf"
                          className="hidden"
                          onChange={(event) => {
                            applySelectedFile(event.target.files?.[0] ?? null);
                          }}
                        />
                      </label>

                      <div className="mt-4 rounded-[16px] border border-[rgba(15,198,194,0.14)] bg-[#f8fcfe] px-4 py-3 text-sm text-slate-600">
                        <div className="font-semibold text-slate-800">当前文件</div>
                        <div className="mt-1 truncate">{selectedFile?.name ?? "暂未选择"}</div>
                        <div className="mt-2 text-xs text-slate-400">
                          {selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB` : "选好文件后，就可以生成规则或直接试解析。"}
                        </div>
                      </div>

                      {parseProgress && <ProgressBar label={parseProgress.label} value={parseProgress.value} className="mt-4" />}
                      {submitProgress && <ProgressBar label={submitProgress.label} value={submitProgress.value} className="mt-4" tone="orange" />}

                      <div className="mt-4 flex flex-wrap gap-2">
                        <ActionButton
                          icon={<WandSparkles className="h-4 w-4" />}
                          label="AI 生成规则"
                          busy={busyKey === "suggest-rule"}
                          onClick={handleGenerateRule}
                        />
                        <ActionButton
                          icon={<Play className="h-4 w-4" />}
                          label="试解析"
                          busy={busyKey === "preview-parse"}
                          onClick={handleTestParse}
                          tone="secondary"
                        />
                        <ActionButton
                          icon={<UploadCloud className="h-4 w-4" />}
                          label="提交下单"
                          busy={busyKey === "submit-preview"}
                          onClick={handleSubmitPreview}
                          tone="orange"
                        />
                      </div>
                    </Panel>

                    <Panel
                      title="规则选择"
                      description="这里由你手动挑选规则，不做自动匹配。"
                      icon={<LayoutPanelLeft className="h-4 w-4" />}
                    >
                      <div className="mb-4 flex flex-wrap gap-2">
                        <ActionButton
                          icon={<Sparkles className="h-4 w-4" />}
                          label="新建规则"
                          onClick={handleCreateRuleDraft}
                          tone="secondary"
                        />
                      </div>
                      <select
                        value={selectedRuleId}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          setSelectedRuleId(nextId);
                          const matched = rules.find((rule) => rule.id === nextId);
                          if (matched) {
                            setRuleDraftText(JSON.stringify(matched, null, 2));
                            setAiNotes(matched.aiSummary ? [matched.aiSummary] : []);
                          }
                        }}
                        className="w-full rounded-[14px] border border-[rgba(15,198,194,0.18)] bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-[rgba(15,198,194,0.42)]"
                      >
                        <option value="">请选择已有规则</option>
                        {savedRules.map((rule) => (
                          <option key={rule.id} value={rule.id}>
                            {rule.name}
                          </option>
                        ))}
                      </select>

                      <div className="mt-4 space-y-2">
                        {savedRules.slice(0, 4).map((rule) => (
                          <button
                            key={rule.id}
                            type="button"
                            onClick={() => selectRule(rule)}
                            className={cn(
                              "flex w-full items-start justify-between rounded-[16px] border px-4 py-3 text-left transition",
                              selectedRuleId === rule.id
                                ? "border-[rgba(15,198,194,0.32)] bg-[rgba(15,198,194,0.08)]"
                                : "border-[rgba(15,198,194,0.1)] bg-white hover:bg-[#f8fcfe]",
                            )}
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-slate-800">{rule.name}</div>
                              <div className="mt-1 text-xs text-slate-500">{getExtractorLabel(rule.extractor.kind)}</div>
                            </div>
                            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[#10a8c2]" />
                          </button>
                        ))}
                      </div>
                    </Panel>

                    <Panel
                      title="AI 备注"
                      description="AI 拿不准的地方会放在这里，方便你逐项确认。"
                      icon={<AlertCircle className="h-4 w-4" />}
                    >
                      <div className="space-y-2 text-sm text-slate-600">
                        {aiNotes.length ? (
                          aiNotes.map((note) => (
                            <div key={note} className="rounded-[14px] border border-amber-100 bg-amber-50 px-3 py-3">
                              {note}
                            </div>
                          ))
                        ) : (
                          <div className="rounded-[14px] border border-dashed border-slate-200 px-3 py-6 text-center text-slate-400">
                            生成规则后，这里会展示需要你确认的推测项。
                          </div>
                        )}
                      </div>
                    </Panel>
                  </div>

                  <div className="space-y-4">
                    <Panel
                      title="规则草稿"
                      description="推荐规则会先放在这里，你可以改完再保存。"
                      icon={<Save className="h-4 w-4" />}
                    >
                      <textarea
                        value={ruleDraftText}
                        onChange={(event) => setRuleDraftText(event.target.value)}
                        className="min-h-[360px] w-full rounded-[18px] border border-[rgba(15,198,194,0.16)] bg-[#081d26] px-4 py-4 font-mono text-[12px] leading-6 text-cyan-50 outline-none focus:border-[rgba(15,198,194,0.42)]"
                        placeholder="先点“新建规则”或“AI 生成规则”，规则内容会显示在这里。"
                      />
                      <div className="mt-4 flex flex-wrap gap-2">
                        <ActionButton
                          icon={<Save className="h-4 w-4" />}
                          label="保存规则"
                          busy={busyKey === "save-rule"}
                          onClick={handleSaveRule}
                        />
                        <ActionButton
                          icon={<Copy className="h-4 w-4" />}
                          label="复制当前规则"
                          busy={Boolean(parsedDraftRule && busyKey === `duplicate-${parsedDraftRule.id}`)}
                          onClick={() => parsedDraftRule && handleDuplicateRule(parsedDraftRule)}
                          tone="secondary"
                        />
                      </div>
                    </Panel>

                    <DocumentSummaryPanel summary={documentSummary} />

                    {previewRows.length > 0 ? (
                      <>
                        <div className="grid gap-4 lg:grid-cols-4">
                          <SummaryTile title="结果行数" value={String(previewRows.length)} hint="已经展开成可编辑明细" />
                          <SummaryTile title="出库单数" value={String(aggregatedOrders.length)} hint="按外部编码聚合后的单据数" />
                          <SummaryTile title="累计数量" value={String(totalPreviewQty)} hint="会跟随你当前改动实时更新" />
                          <SummaryTile
                            title="校验结果"
                            value={
                              hasPreviewErrors
                                ? `${blockingIssues.length} 项错误`
                                : warningIssues.length
                                  ? `${warningIssues.length} 项提醒`
                                  : "可提交"
                            }
                            hint={
                              hasPreviewErrors
                                ? "红色错误处理完才可以提交"
                                : warningIssues.length
                                  ? "橙色提醒不影响提交，建议先确认"
                                  : "当前结果已通过基础校验"
                            }
                            tone={hasPreviewErrors ? "danger" : warningIssues.length ? "amber" : "success"}
                          />
                        </div>

                        <AggregatedOrdersPanel orders={aggregatedOrders} />

                        <PreviewTable
                          rows={previewRows}
                          issues={previewIssues}
                          onChange={handlePreviewCellChange}
                          onDeleteRow={handleDeletePreviewRow}
                          onAddRow={handleAddPreviewRow}
                        />

                        <Panel
                          title="校验清单"
                          description="问题会一次列全，方便你集中修改。"
                          icon={<ShieldCheck className="h-4 w-4" />}
                        >
                          {previewIssues.length ? (
                            <div className="space-y-2">
                              {previewIssues.map((issue) => (
                                <div
                                  key={`${issue.rowId}-${issue.field}-${issue.message}`}
                                  className={cn(
                                    "rounded-[14px] border px-4 py-3 text-sm",
                                    issue.severity === "error"
                                      ? "border-rose-100 bg-rose-50 text-rose-700"
                                      : "border-amber-100 bg-amber-50 text-amber-700",
                                  )}
                                >
                                  第 {issue.rowIndex} 行 · {issue.field === "row" ? "整行" : FIELD_LABELS[issue.field]} · {issue.message}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-[16px] border border-emerald-100 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">
                              当前结果没有发现阻断性错误，可以直接提交下单。
                            </div>
                          )}

                          <div className="mt-4 flex flex-wrap gap-2">
                            <ActionButton
                              icon={<FileSpreadsheet className="h-4 w-4" />}
                              label="导出当前预览"
                              onClick={handleExportPreview}
                              tone="secondary"
                            />
                          </div>
                        </Panel>
                      </>
                    ) : (
                      <EmptyWorkbench />
                    )}
                  </div>
                </div>
              )}

              {activeSection === "rules" && (
                <div className="space-y-4">
                  <div className="grid gap-4 lg:grid-cols-3">
                    <SummaryTile title="可用规则" value={String(savedRules.length)} hint="保存后可直接用于导入" />
                    <SummaryTile title="模板规则" value={String(templateRules.length)} hint="适合拿来做新格式起步" />
                    <SummaryTile title="解析方式" value={String(new Set(rules.map((item) => item.extractor.kind)).size)} hint="已覆盖多种文件结构" />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    {visibleRules.map((rule) => (
                      <article
                        key={rule.id}
                        className="rounded-[22px] border border-[rgba(15,198,194,0.14)] bg-white p-5 shadow-[0_14px_44px_rgba(8,66,88,0.08)]"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="truncate text-base font-semibold text-slate-900">{rule.name}</h3>
                              {rule.isTemplate && <Pill tone="amber">模板</Pill>}
                              <Pill tone="cyan">{getExtractorLabel(rule.extractor.kind)}</Pill>
                            </div>
                            <p className="mt-2 text-sm text-slate-500">{rule.description}</p>
                          </div>
                          <div className="rounded-2xl bg-[rgba(15,198,194,0.1)] px-3 py-2 text-xs font-semibold text-[#0f8b99]">
                            {rule.sourceType}
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <MiniMetric label="样例文件" value={rule.sampleFileName ?? "模板规则"} />
                          <MiniMetric label="更新时间" value={formatDateTime(rule.updatedAt)} />
                        </div>

                        <div className="mt-4 rounded-[16px] border border-[rgba(15,198,194,0.1)] bg-[#f8fcfe] px-4 py-4 text-sm text-slate-600">
                          {rule.aiSummary ?? "这条规则已经保存好，可以直接带回导入页试解析。"}
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <ActionButton
                            icon={<Play className="h-4 w-4" />}
                            label="带回导入台"
                            onClick={() => selectRule(rule)}
                          />
                          <ActionButton
                            icon={<Copy className="h-4 w-4" />}
                            label="复制"
                            busy={busyKey === `duplicate-${rule.id}`}
                            onClick={() => handleDuplicateRule(rule)}
                            tone="secondary"
                          />
                          {!rule.isTemplate && (
                            <ActionButton
                              icon={<Trash2 className="h-4 w-4" />}
                              label="删除"
                              busy={busyKey === `delete-${rule.id}`}
                              onClick={() => handleDeleteRule(rule.id)}
                              tone="danger"
                            />
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === "shipments" && (
                <div className="space-y-4">
                  <Panel
                    title="历史运单检索"
                    description="按外部编码、收件人和时间范围筛选历史导入记录。"
                    icon={<Database className="h-4 w-4" />}
                  >
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_170px_170px_auto]">
                      <input
                        value={historyQuery}
                        onChange={(event) => setHistoryQuery(event.target.value)}
                        className="rounded-[14px] border border-[rgba(15,198,194,0.16)] bg-white px-4 py-3 text-sm outline-none focus:border-[rgba(15,198,194,0.42)]"
                        placeholder="搜外部编码 / SKU / 门店"
                      />
                      <input
                        value={historyRecipient}
                        onChange={(event) => setHistoryRecipient(event.target.value)}
                        className="rounded-[14px] border border-[rgba(15,198,194,0.16)] bg-white px-4 py-3 text-sm outline-none focus:border-[rgba(15,198,194,0.42)]"
                        placeholder="收件人姓名"
                      />
                      <input
                        type="date"
                        value={historyDateFrom}
                        onChange={(event) => setHistoryDateFrom(event.target.value)}
                        className="rounded-[14px] border border-[rgba(15,198,194,0.16)] bg-white px-4 py-3 text-sm outline-none focus:border-[rgba(15,198,194,0.42)]"
                      />
                      <input
                        type="date"
                        value={historyDateTo}
                        onChange={(event) => setHistoryDateTo(event.target.value)}
                        className="rounded-[14px] border border-[rgba(15,198,194,0.16)] bg-white px-4 py-3 text-sm outline-none focus:border-[rgba(15,198,194,0.42)]"
                      />
                      <ActionButton
                        icon={<Search className="h-4 w-4" />}
                        label="查询"
                        busy={busyKey === "history-search"}
                        onClick={() => handleHistorySearch(1)}
                      />
                    </div>
                  </Panel>

                  <ShipmentsPanel shipments={shipments} onPageChange={handleHistorySearch} />
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function DashboardSection({
  dashboard,
  onRefresh,
  busy,
}: {
  dashboard: DashboardSnapshot | null;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <SummaryTile title="可用规则" value={String(dashboard?.ruleCount ?? 0)} hint="保存后可直接带回导入页使用" />
        <SummaryTile title="模板规则" value={String(dashboard?.templateCount ?? 0)} hint="适合用来起新规则" />
        <SummaryTile title="历史明细" value={String(dashboard?.shipmentRowCount ?? 0)} hint="已入库的行级数据总数" />
        <SummaryTile title="导入批次" value={String(dashboard?.batchCount ?? 0)} hint="每次提交都会生成一个批次" />
        <SummaryTile
          title="重复提醒"
          value={String(dashboard?.duplicateExternalCodeCount ?? 0)}
          hint="和历史数据冲突的外部编码数量"
          tone={(dashboard?.duplicateExternalCodeCount ?? 0) > 0 ? "amber" : "success"}
        />
        <SummaryTile title="解析方式" value={String(dashboard?.strategyCount ?? 0)} hint="已覆盖的规则提取方式" />
      </div>

      <Panel
        title="工作概览"
        description="这里帮助你快速判断当前批次是否已经可以提交。"
        icon={<Boxes className="h-4 w-4" />}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <PipelineCard title="现有规则" value={`${dashboard?.ruleCount ?? 0} 条`} desc="上传后由你手动选择合适规则，不做自动匹配。" accent="#0fc6c2" />
          <PipelineCard title="试解析与改值" value="在线预览" desc="试解析后可以直接在表格里修改、补行和删行。" accent="#1aa0c6" />
          <PipelineCard title="历史去重提醒" value={`${dashboard?.duplicateExternalCodeCount ?? 0} 项`} desc="提交前会和历史数据比对外部编码冲突。" accent="#ff9a34" />
          <PipelineCard title="最近导入" value={formatDateTime(dashboard?.lastImportedAt)} desc="提交后的结果可以在历史记录里继续回看。" accent="#ff5d73" />
        </div>

        <div className="mt-4">
          <ActionButton
            icon={<RefreshCw className="h-4 w-4" />}
            label="刷新看板"
            busy={busy}
            onClick={onRefresh}
          />
        </div>
      </Panel>
    </div>
  );
}

function ShipmentsPanel({
  shipments,
  onPageChange,
}: {
  shipments: ShipmentSearchResult | null;
  onPageChange: (page: number) => void;
}) {
  const orders = shipments?.orders ?? [];
  const totalOrders = shipments?.totalOrders ?? orders.length;
  const totalPages = shipments ? Math.ceil(totalOrders / shipments.pageSize) : 0;

  return (
    <Panel
      title="已导入出库单列表"
      description="这里按外部编码聚合展示，同一外部编码下的多个 SKU 共享一组收货信息。"
      icon={<FileText className="h-4 w-4" />}
    >
      <div className="overflow-hidden rounded-[18px] border border-[rgba(15,198,194,0.12)]">
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white text-sm">
            <thead className="bg-[#f4fbfc] text-left text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">外部编码</th>
                <th className="px-4 py-3 font-semibold">门店 / 收件人</th>
                <th className="px-4 py-3 font-semibold">SKU 数</th>
                <th className="px-4 py-3 font-semibold">合计数量</th>
                <th className="px-4 py-3 font-semibold">导入时间</th>
              </tr>
            </thead>
            <tbody>
              {orders.length ? (
                orders.map((order) => (
                  <tr key={order.id} className="border-t border-[rgba(15,198,194,0.08)] text-slate-700">
                    <td className="px-4 py-3 font-medium">{order.externalCode || "--"}</td>
                    <td className="px-4 py-3">
                      <div>{order.storeName || "--"}</div>
                      <div className="mt-1 text-xs text-slate-400">{order.recipientName || "未填写收件人"}</div>
                    </td>
                    <td className="px-4 py-3">{order.skuCount}</td>
                    <td className="px-4 py-3">{order.totalQty}</td>
                    <td className="px-4 py-3 text-slate-500">{formatDateTime(order.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-slate-400">
                    还没有历史出库单，先去“导入解析”完成一批数据吧。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {shipments && totalOrders > shipments.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <div>
            共 {totalOrders} 张出库单，第 {shipments.page} / {totalPages} 页
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, shipments.page - 1))}
              className="rounded-full border border-[rgba(15,198,194,0.16)] px-4 py-2 hover:bg-[#f8fcfe]"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() =>
                onPageChange(
                  Math.min(totalPages, shipments.page + 1),
                )
              }
              className="rounded-full border border-[rgba(15,198,194,0.16)] px-4 py-2 hover:bg-[#f8fcfe]"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {shipments?.batches.length ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {shipments.batches.slice(0, 3).map((batch) => (
            <div
              key={batch.id}
              className="rounded-[18px] border border-[rgba(15,198,194,0.12)] bg-[#f8fcfe] px-4 py-4 text-sm text-slate-600"
            >
              <div className="font-semibold text-slate-900">{batch.fileName}</div>
              <div className="mt-2">批次号：{batch.id}</div>
              <div className="mt-1">成功 {batch.successCount} 行 / 失败 {batch.failedCount} 行</div>
              <div className="mt-1 text-xs text-slate-400">{formatDateTime(batch.createdAt)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function AggregatedOrdersPanel({ orders }: { orders: ShipmentOrder[] }) {
  const visibleOrders = orders.slice(0, 8);
  const hiddenCount = Math.max(0, orders.length - visibleOrders.length);

  return (
    <Panel
      title="聚合出库单"
      description="同一外部编码下的 SKU 会共享同一组收货信息，并作为一张出库单提交。"
      icon={<Boxes className="h-4 w-4" />}
    >
      <div className="grid gap-3 xl:grid-cols-2">
        {visibleOrders.map((order, index) => (
          <div
            key={order.id}
            className="rounded-[18px] border border-[rgba(15,198,194,0.12)] bg-[#f8fcfe] px-4 py-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">
                  {order.externalCode || `未填写外部编码 #${index + 1}`}
                </div>
                <div className="mt-1 truncate text-xs text-slate-500">
                  {order.storeName || order.recipientName || "收货信息待补齐"}
                </div>
              </div>
              <Pill tone="cyan">{order.skuCount} SKU</Pill>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <MiniMetric label="合计数量" value={String(order.totalQty)} />
              <MiniMetric label="收货电话" value={order.recipientPhone || "--"} />
            </div>
          </div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <div className="mt-3 rounded-[14px] border border-[rgba(15,198,194,0.12)] bg-white px-4 py-3 text-sm text-slate-500">
          还有 {hiddenCount} 张出库单未展开显示，行级明细仍在下方表格中完整保留。
        </div>
      )}
    </Panel>
  );
}

function DocumentSummaryPanel({ summary }: { summary: DocumentSummary | null }) {
  return (
    <Panel
      title="文件概览"
      description="这里会展示文件结构，方便确认是否读对了。"
      icon={<FileText className="h-4 w-4" />}
    >
      {summary ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <MiniMetric label="文件名" value={summary.fileName} />
            <MiniMetric label="文件类型" value={summary.fileType} />
            <MiniMetric label="Sheet / 页面" value={`${summary.sheetCount} / ${summary.pageCount}`} />
          </div>

          {summary.sheetPreviews.length ? (
            <div className="grid gap-3 xl:grid-cols-2">
              {summary.sheetPreviews.map((sheet) => (
                <div
                  key={sheet.name}
                  className="rounded-[16px] border border-[rgba(15,198,194,0.1)] bg-[#f8fcfe] px-4 py-4"
                >
                  <div className="text-sm font-semibold text-slate-900">
                    {sheet.name} · {sheet.rowCount} 行 / {sheet.columnCount} 列
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-[12px] bg-white px-3 py-3 text-[11px] leading-5 text-slate-600">
                    {JSON.stringify(sheet.firstRows, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <pre className="overflow-x-auto rounded-[16px] border border-[rgba(15,198,194,0.1)] bg-[#f8fcfe] px-4 py-4 text-[12px] leading-6 text-slate-600">
              {summary.textPreview || "暂无文本预览"}
            </pre>
          )}
        </div>
      ) : (
        <div className="rounded-[16px] border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
          上传文件或试解析后，这里会展示文件概览。
        </div>
      )}
    </Panel>
  );
}

function Panel({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[22px] border border-[rgba(15,198,194,0.14)] bg-white p-5 shadow-[0_14px_44px_rgba(8,66,88,0.08)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[rgba(15,198,194,0.1)] text-[#0f8b99]">
          {icon}
        </div>
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function SummaryTile({
  title,
  value,
  hint,
  tone = "cyan",
}: {
  title: string;
  value: string;
  hint: string;
  tone?: "cyan" | "success" | "danger" | "amber";
}) {
  const classes =
    tone === "success"
      ? "from-emerald-50 to-white text-emerald-700"
      : tone === "danger"
        ? "from-rose-50 to-white text-rose-700"
        : tone === "amber"
          ? "from-amber-50 to-white text-amber-700"
        : "from-cyan-50 to-white text-[#0f8b99]";

  return (
    <article className={cn("rounded-[22px] border border-[rgba(15,198,194,0.14)] bg-gradient-to-b p-5 shadow-[0_12px_36px_rgba(8,66,88,0.08)]", classes)}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-4 text-[32px] font-semibold tracking-normal text-slate-900">{value}</div>
      <div className="mt-2 text-sm text-slate-500">{hint}</div>
    </article>
  );
}

function PipelineCard({
  title,
  value,
  desc,
  accent,
}: {
  title: string;
  value: string;
  desc: string;
  accent: string;
}) {
  return (
    <div className="rounded-[20px] border border-[rgba(15,198,194,0.12)] bg-white px-4 py-4">
      <div className="flex items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: accent }} />
        <div className="text-sm font-semibold text-slate-700">{title}</div>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-normal text-slate-900">{value}</div>
      <div className="mt-2 text-sm text-slate-500">{desc}</div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-[rgba(15,198,194,0.12)] bg-[#f8fcfe] px-4 py-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function ProgressBar({
  label,
  value,
  tone = "cyan",
  className,
}: {
  label: string;
  value: number;
  tone?: "cyan" | "orange";
  className?: string;
}) {
  return (
    <div className={cn("rounded-[16px] border border-[rgba(15,198,194,0.12)] bg-[#f8fcfe] px-4 py-3", className)}>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>{Math.round(value)}%</span>
      </div>
      <div className="mt-3 h-3 overflow-hidden rounded-full bg-white">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            tone === "orange"
              ? "bg-[linear-gradient(90deg,#ffb35c_0%,#ff8f2f_100%)]"
              : "bg-[linear-gradient(90deg,#12d6d2_0%,#0f9fc6_100%)]",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "amber" | "cyan";
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[11px] font-semibold",
        tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-cyan-50 text-[#0f8b99]",
      )}
    >
      {children}
    </span>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  busy,
  tone = "primary",
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone?: "primary" | "secondary" | "orange" | "danger";
}) {
  const classes =
    tone === "secondary"
      ? "border-[rgba(15,198,194,0.18)] bg-white text-slate-700 hover:bg-[#f8fcfe]"
      : tone === "orange"
        ? "border-transparent bg-[linear-gradient(90deg,#ffb35c_0%,#ff9232_100%)] text-white"
        : tone === "danger"
          ? "border-transparent bg-[linear-gradient(90deg,#ff7186_0%,#ff5678_100%)] text-white"
          : "border-transparent bg-[linear-gradient(90deg,#12d6d2_0%,#0f9fc6_100%)] text-white";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
        classes,
      )}
    >
      {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : icon}
      <span>{label}</span>
    </button>
  );
}

function ToastStack({ items }: { items: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed right-5 top-5 z-50 flex w-[320px] max-w-[calc(100vw-40px)] flex-col gap-3">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "rounded-[18px] border px-4 py-3 text-sm shadow-[0_18px_44px_rgba(7,67,93,0.16)] backdrop-blur",
            item.tone === "success" && "border-emerald-100 bg-emerald-50/95 text-emerald-700",
            item.tone === "error" && "border-rose-100 bg-rose-50/95 text-rose-700",
            item.tone === "info" && "border-cyan-100 bg-cyan-50/95 text-[#0f8b99]",
          )}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}

function EmptyWorkbench() {
  return (
    <div className="rounded-[24px] border border-[rgba(15,198,194,0.14)] bg-[linear-gradient(180deg,#f8fcfe_0%,#f3f9fc_100%)] px-6 py-16 text-center shadow-[0_12px_36px_rgba(8,66,88,0.08)]">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-[28px] bg-white text-[#0f8b99] shadow-[0_18px_40px_rgba(8,66,88,0.1)]">
        <Sparkles className="h-8 w-8" />
      </div>
      <h3 className="mt-5 text-xl font-semibold text-slate-900">文件和规则准备好后，就可以开始试解析</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-7 text-slate-500">
        左侧先上传文件，再选择已有规则或新建一条规则。试解析完成后，结果表支持直接改值、删行、补行和导出。
      </p>
    </div>
  );
}

function getExtractorLabel(kind: DocumentRule["extractor"]["kind"]) {
  switch (kind) {
    case "tabular":
      return "标准表格";
    case "matrixColumns":
      return "矩阵展开";
    case "cardBlocks":
      return "卡片拆分";
    case "textBlocks":
      return "分段文本";
    case "textTable":
      return "文本表格";
    case "llmStructured":
      return "AI 结构提取";
    default:
      return kind;
  }
}

function buildBlankRule(fileName?: string): DocumentRule {
  return {
    id: makeId("rule"),
    name: fileName ? `${stripExtension(fileName)} 规则` : "新规则",
    description: "请先根据当前文件补充或调整这条规则。",
    sourceType: guessFileType(fileName),
    extractor: {
      kind: "tabular",
      sheetSelector: { mode: "first" },
      headerRow: 1,
      dataStartRow: 2,
      fieldMappings: [
        { field: "externalCode", source: { kind: "header", header: "外部编码" } },
        { field: "storeName", source: { kind: "header", header: "收货门店" } },
        { field: "recipientName", source: { kind: "header", header: "收件人姓名" } },
        { field: "recipientPhone", source: { kind: "header", header: "收件人电话" } },
        { field: "recipientAddress", source: { kind: "header", header: "收件人地址" } },
        { field: "skuCode", source: { kind: "header", header: "SKU物品编码" } },
        { field: "skuName", source: { kind: "header", header: "SKU物品名称" } },
        { field: "skuQty", source: { kind: "header", header: "SKU发货数量" } },
        { field: "skuSpec", source: { kind: "header", header: "SKU规格型号" } },
        { field: "temperatureZone", source: { kind: "header", header: "温层" } },
        { field: "remark", source: { kind: "header", header: "备注" } },
      ],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    aiSummary: "这是新建的空白规则草稿，建议结合当前文件先做一次试解析再保存。",
  };
}

function guessFileType(fileName?: string): DocumentRule["sourceType"] {
  if (!fileName) {
    return "mixed";
  }

  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return "excel";
  }
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (lower.endsWith(".docx")) {
    return "word";
  }

  return "mixed";
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
  });
  await ensureOk(response);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  await ensureOk(response);
  return (await response.json()) as T;
}

async function postForm<T>(url: string, payload: FormData) {
  const response = await fetch(url, {
    method: "POST",
    body: payload,
  });
  await ensureOk(response);
  return (await response.json()) as T;
}

async function ensureOk(response: Response) {
  if (response.ok) {
    return;
  }

  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  throw new ApiError(payload?.error ?? `请求失败：${response.status}`, payload ?? {});
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, ChevronLeft, ChevronRight, Clock3, Download, Gauge, Search } from "lucide-react";

import { SystemNav } from "@/components/system-nav";
import type { BatchPerformance, ImportTask, ImportTaskError, MonitorSummary, TraceEvent } from "@/lib/async-import-types";

type ErrorPage = { items: ImportTaskError[]; total: number; page: number; pageSize: number };
type TraceSearchResult = { tasks: Array<{ id: string; trace_id: string; file_name: string }>; events: TraceEvent[]; errors: ImportTaskError[] };
type TraceFilters = { taskId: string; traceId: string; fileName: string; batch: string; rowFrom: string; rowTo: string; errorCode: string };

const EMPTY_TRACE_FILTERS: TraceFilters = { taskId: "", traceId: "", fileName: "", batch: "", rowFrom: "", rowTo: "", errorCode: "" };
const ERROR_CODES = ["E001", "E002", "E003", "E004", "E005", "E006", "E007", "E008", "E009"];
const ERROR_LABELS: Record<string, string> = { E001: "SKU 不存在", E002: "必填缺失", E003: "电话错误", E004: "数量错误", E005: "外部编码冲突", E006: "规则映射失败", E007: "数据库写入失败", E008: "文件格式错误", E009: "SKU 校验降级" };

export function OperationsConsole() {
  const [taskQuery, setTaskQuery] = useState("");
  const [task, setTask] = useState<ImportTask | null>(null);
  const [monitor, setMonitor] = useState<MonitorSummary | null>(null);
  const [errors, setErrors] = useState<ErrorPage | null>(null);
  const [, setPerformanceLogs] = useState<BatchPerformance[]>([]);
  const [traceResult, setTraceResult] = useState<TraceSearchResult>({ tasks: [], events: [], errors: [] });
  const [traceFilters, setTraceFilters] = useState<TraceFilters>(EMPTY_TRACE_FILTERS);
  const [errorCode, setErrorCode] = useState("");
  const [batch, setBatch] = useState("");
  const [message, setMessage] = useState("");

  const refreshMonitor = useCallback(async () => {
    const response = await fetch("/api/import-monitor/summary", { cache: "no-store" });
    if (response.ok) setMonitor(await response.json());
  }, []);

  const searchTrace = useCallback(async (filters: TraceFilters) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value.trim()) query.set(({ taskId: "task_id", traceId: "trace_id", fileName: "file_name", rowFrom: "row_from", rowTo: "row_to", errorCode: "error_code" } as Record<string, string>)[key] ?? key, value.trim());
    }
    if (!query.size) { setMessage("请至少填写一个 Trace 检索条件"); return; }
    const response = await fetch(`/api/traces?${query}`, { cache: "no-store" });
    const data = await response.json() as TraceSearchResult & { error?: string };
    if (!response.ok) { setMessage(data.error ?? "Trace 检索失败"); return; }
    setTraceResult(data);
    setMessage(data.tasks.length ? "" : "未找到匹配的链路记录");
  }, []);

  const loadTask = useCallback(async (id: string, page = 1, filters?: { batch?: string; errorCode?: string }) => {
    if (!id.trim()) return;
    const query = new URLSearchParams({ page: String(page), page_size: "50" });
    const selectedBatch = filters?.batch ?? batch;
    const selectedErrorCode = filters?.errorCode ?? errorCode;
    if (selectedBatch.trim()) query.set("batch", selectedBatch.trim());
    if (selectedErrorCode) query.set("error_code", selectedErrorCode);
    const [taskResponse, errorResponse, batchResponse] = await Promise.all([
      fetch(`/api/import-tasks/${encodeURIComponent(id.trim())}`, { cache: "no-store" }),
      fetch(`/api/import-tasks/${encodeURIComponent(id.trim())}/errors?${query}`, { cache: "no-store" }),
      fetch(`/api/import-tasks/${encodeURIComponent(id.trim())}/batches`, { cache: "no-store" }),
    ]);
    if (!taskResponse.ok) { setMessage("任务不存在或无权访问"); return; }
    const nextTask = await taskResponse.json() as ImportTask;
    setTask(nextTask);
    setTaskQuery(nextTask.id);
    setTraceFilters((current) => ({ ...current, taskId: nextTask.id, traceId: nextTask.traceId }));
    setMessage("");
    if (errorResponse.ok) setErrors(await errorResponse.json());
    if (batchResponse.ok) setPerformanceLogs((await batchResponse.json()).performance);
    await searchTrace({ ...EMPTY_TRACE_FILTERS, traceId: nextTask.traceId });
  }, [batch, errorCode, searchTrace]);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshMonitor();
      const taskId = new URLSearchParams(window.location.search).get("task_id");
      if (taskId) void loadTask(taskId);
    });
  }, [loadTask, refreshMonitor]);

  useEffect(() => {
    if (!task || ["completed", "partial_success", "failed"].includes(task.status)) return;
    const timer = window.setInterval(() => { void loadTask(task.id, errors?.page ?? 1); void refreshMonitor(); }, 1_500);
    return () => window.clearInterval(timer);
  }, [task, errors?.page, loadTask, refreshMonitor]);

  const progress = task ? Math.round(task.processedRows / Math.max(1, task.totalRows) * 100) : 0;
  const maxThroughput = Math.max(1, ...(monitor?.throughput.map((item) => item.rows) ?? [1]));
  const totalErrorPages = errors ? Math.max(1, Math.ceil(errors.total / errors.pageSize)) : 1;

  return <main className="min-h-screen bg-[#edf5fb] p-4 text-slate-800"><div className="mx-auto max-w-[1500px] space-y-4">
    <header className="flex flex-col gap-4 rounded-md border border-cyan-100 bg-white p-5 lg:flex-row lg:items-center lg:justify-between"><div><div className="text-sm font-bold text-[#0f9f9b]">智能多格式批量下单系统</div><h1 className="mt-1 text-2xl font-semibold">导入任务监控</h1><p className="mt-1 text-sm text-slate-500">异步处理进度、行级错误与全链路性能追踪</p></div><SystemNav current="monitor" /></header>
    {message ? <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{message}</div> : null}
    {monitor?.alerts.length ? <section className="grid gap-2 md:grid-cols-2">{monitor.alerts.map((alert) => <div className={`flex items-center gap-2 rounded-md border px-4 py-3 text-sm ${alert.severity === "critical" ? "border-rose-300 bg-rose-50 text-rose-700" : "border-amber-300 bg-amber-50 text-amber-800"}`} key={alert.type}><AlertTriangle className="h-4 w-4 shrink-0" /><span>{alert.message}</span><b className="ml-auto">{alert.count}</b></div>)}</section> : null}

    <Panel title="任务检索与进度" icon={<Activity className="h-4 w-4" />}><div className="mb-4 flex gap-2"><input className="field" value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder="输入 task_id" /><button className="mini flex items-center gap-1" onClick={() => void loadTask(taskQuery)}><Search className="h-4 w-4" />查询</button></div>{task ? <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Small label="状态" value={statusLabel(task.status)} /><Small label="task_id" value={task.id} /><Small label="trace_id" value={task.traceId} /><Small label="文件" value={task.fileName} /></div><div className="mt-4 h-3 overflow-hidden rounded bg-slate-100"><div className="h-full bg-[#0fc6c2] transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{progress}% · {task.processedRows}/{task.totalRows} 行 · {task.completedBatches}/{task.totalBatches} 批</span><span>成功 {task.successRows} · 失败 {task.failedRows} · {task.throughputPerMinute} 行/分钟 · ETA {task.estimatedSecondsRemaining ?? "-"} 秒</span></div>{task.degraded ? <div className="mt-4 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="h-4 w-4 shrink-0" />SKU 校验已降级：本次导入未经过商品主数据完整校验，数据可能需要后续复核。{task.degradedReason}</div> : null}{task.recentError ? <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-700">最近错误：{task.recentError}</div> : null}</> : <Empty text="从导入下单页提交后自动进入此处，也可按 task_id 检索。" />}</Panel>

    <section className="grid gap-3 md:grid-cols-4"><Metric label="近 5 分钟入库" value={`${monitor?.throughput.reduce((sum, item) => sum + item.rows, 0) ?? 0} 行`} icon={<Gauge />} /><Metric label="队列积压" value={`${monitor?.queue.pendingRows ?? 0} 行`} tone={monitor?.queue.alert} icon={<Activity />} /><Metric label="阶段总耗时 P99" value={`${monitor?.durationPercentiles.total.p99 ?? 0} ms`} icon={<Clock3 />} /><Metric label="队列状态" value={monitor?.queue.available ? "可用" : "未配置 / 不可用"} tone={monitor?.queue.available ? "normal" : "critical"} icon={<AlertTriangle />} /></section>
    <section className="grid gap-4 xl:grid-cols-2"><Panel title="过去 5 分钟吞吐量" icon={<Gauge className="h-4 w-4" />}><div className="flex h-48 items-end gap-3 overflow-x-auto border-b border-slate-200 px-2">{monitor?.throughput.length ? monitor.throughput.map((item) => <div key={item.minute} className="flex min-w-16 flex-1 flex-col items-center gap-2"><span className="text-xs">{item.rows}</span><div className="w-full max-w-14 bg-[#0fc6c2]" style={{ height: `${Math.max(4, item.rows / maxThroughput * 140)}px` }} /><span className="text-[10px] text-slate-400">{new Date(item.minute).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span></div>) : <Empty text="暂无真实处理数据" />}</div></Panel><Panel title="阶段耗时分布" icon={<Clock3 className="h-4 w-4" />}><table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="py-2">阶段</th><th>P50</th><th>P95</th><th>P99</th></tr></thead><tbody>{monitor ? Object.entries(monitor.durationPercentiles).map(([name, item]) => <tr className="border-t border-slate-100" key={name}><td className="py-3">{name}</td><td>{item.p50}ms</td><td>{item.p95}ms</td><td className="font-semibold">{item.p99}ms</td></tr>) : null}</tbody></table></Panel></section>

    <section className="grid gap-4 xl:grid-cols-2"><Panel title="错误类型分布" icon={<AlertTriangle className="h-4 w-4" />}>{monitor?.errors.length ? <div className="space-y-3">{monitor.errors.map((item) => <button className="block w-full text-left" key={item.code} onClick={() => { setErrorCode(item.code); if (task) void loadTask(task.id, 1, { errorCode: item.code }); }}><div className="mb-1 flex justify-between gap-3 text-sm"><span><b className="font-mono text-rose-600">{item.code}</b> · {ERROR_LABELS[item.code] ?? "其他错误"}</span><span>{item.count} · {item.percentage.toFixed(1)}%</span></div><div className="h-2 overflow-hidden rounded bg-slate-100"><div className="h-full bg-rose-400" style={{ width: `${Math.max(2, item.percentage)}%` }} /></div></button>)}</div> : <Empty text="过去 24 小时暂无错误" />}</Panel><Panel title="失败任务趋势" icon={<Activity className="h-4 w-4" />}>{monitor?.failedTaskTrend.length ? <div className="space-y-2">{monitor.failedTaskTrend.map((item) => <div className="flex justify-between border-b border-slate-100 py-2 text-sm" key={item.minute}><span>{new Date(item.minute).toLocaleString("zh-CN")}</span><b className="text-rose-600">{item.count} 个失败任务</b></div>)}</div> : <Empty text="过去 24 小时暂无失败任务" />}</Panel></section>

    <section className="grid gap-4 xl:grid-cols-2"><Panel title="行级错误明细" icon={<AlertTriangle className="h-4 w-4" />}><div className="mb-3 flex flex-wrap gap-2 sm:flex-nowrap"><input className="field min-w-0 flex-1" placeholder="批次号" value={batch} onChange={(event) => setBatch(event.target.value)} /><select className="field min-w-0 flex-1" value={errorCode} onChange={(event) => setErrorCode(event.target.value)}><option value="">全部错误码</option>{ERROR_CODES.map((code) => <option key={code}>{code}</option>)}</select><button title="筛选" className="mini" onClick={() => task && void loadTask(task.id, 1)}><Search className="h-4 w-4" /></button>{task ? <a title="导出失败明细" className="mini" href={`/api/import-tasks/${task.id}/errors/export`}><Download className="h-4 w-4" /></a> : null}</div><ErrorTable items={errors?.items ?? []} /><div className="mt-3 flex items-center justify-between text-xs text-slate-500"><span>共 {errors?.total ?? 0} 条 · 第 {errors?.page ?? 1}/{totalErrorPages} 页</span><div className="flex gap-1"><button title="上一页" className="mini" disabled={!task || !errors || errors.page <= 1} onClick={() => task && errors && void loadTask(task.id, errors.page - 1)}><ChevronLeft className="h-4 w-4" /></button><button title="下一页" className="mini" disabled={!task || !errors || errors.page >= totalErrorPages} onClick={() => task && errors && void loadTask(task.id, errors.page + 1)}><ChevronRight className="h-4 w-4" /></button></div></div></Panel><Panel title="慢批次 TOP 10" icon={<Clock3 className="h-4 w-4" />}><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead><tr className="text-xs text-slate-500"><th className="py-2">任务</th><th>单元</th><th>批次</th><th>总耗时</th></tr></thead><tbody>{monitor?.slowBatches.map((item) => <tr className="border-t" key={`${item.taskId}-${item.unitId}`}><td className="py-2 font-mono text-xs">{item.taskId}</td><td>{item.unitId}</td><td>{item.batchIndex}</td><td>{item.totalDurationMs}ms</td></tr>)}</tbody></table>{!monitor?.slowBatches.length ? <Empty text="暂无批次性能数据" /> : null}</div></Panel></section>

    <Panel title="全链路 Trace 检索" icon={<Search className="h-4 w-4" />}><div className="grid gap-2 md:grid-cols-3 xl:grid-cols-7"><TraceInput label="task_id" value={traceFilters.taskId} onChange={(value) => setTraceFilters((item) => ({ ...item, taskId: value }))} /><TraceInput label="trace_id" value={traceFilters.traceId} onChange={(value) => setTraceFilters((item) => ({ ...item, traceId: value }))} /><TraceInput label="文件名" value={traceFilters.fileName} onChange={(value) => setTraceFilters((item) => ({ ...item, fileName: value }))} /><TraceInput label="批次" value={traceFilters.batch} onChange={(value) => setTraceFilters((item) => ({ ...item, batch: value }))} /><TraceInput label="起始行" value={traceFilters.rowFrom} onChange={(value) => setTraceFilters((item) => ({ ...item, rowFrom: value }))} /><TraceInput label="结束行" value={traceFilters.rowTo} onChange={(value) => setTraceFilters((item) => ({ ...item, rowTo: value }))} /><select aria-label="错误码" className="field" value={traceFilters.errorCode} onChange={(event) => setTraceFilters((item) => ({ ...item, errorCode: event.target.value }))}><option value="">错误码</option>{ERROR_CODES.map((code) => <option key={code}>{code}</option>)}</select></div><div className="mt-2 flex justify-end"><button className="mini flex items-center gap-1" onClick={() => void searchTrace(traceFilters)}><Search className="h-4 w-4" />检索链路</button></div><div className="mt-4 grid gap-4 xl:grid-cols-2"><div className="max-h-[520px] space-y-3 overflow-auto">{traceResult.events.map((event) => <div className="relative border-l-2 border-cyan-200 pl-4" key={event.id}><div className={`absolute -left-[5px] top-1 h-2 w-2 rounded-full ${event.eventStatus === "error" ? "bg-rose-500" : event.eventStatus === "warning" ? "bg-amber-500" : "bg-[#0fc6c2]"}`} /><div className="flex justify-between gap-2 text-xs"><b>{event.eventName}</b><span className="text-slate-400">{new Date(event.occurredAt).toLocaleString("zh-CN")}</span></div><p className="mt-1 text-sm text-slate-600">{event.message}</p><div className="mt-1 font-mono text-[10px] text-slate-400">{event.unitId ?? event.taskId}</div></div>)}{!traceResult.events.length ? <Empty text="输入任一条件检索上传、Outbox、队列、Worker 和错误节点。" /> : null}</div><div><h3 className="mb-2 text-sm font-semibold">匹配的失败节点</h3><ErrorTable items={traceResult.errors} /></div></div></Panel>
  </div></main>;
}

function ErrorTable({ items }: { items: ImportTaskError[] }) { return <div className="max-h-96 overflow-auto"><table className="w-full min-w-[700px] text-left text-xs"><thead><tr>{["批次/行", "字段", "原始值", "错误", "原因", "建议"].map((label) => <th className="sticky top-0 bg-slate-50 p-2" key={label}>{label}</th>)}</tr></thead><tbody>{items.map((item) => <tr className="border-t" key={item.id}><td className="p-2">{item.batchIndex}/{item.rowNumber}</td><td>{item.fieldName}</td><td>{item.rawValue}</td><td className="font-mono text-rose-600">{item.errorCode}</td><td>{item.errorReason}</td><td>{item.suggestion}</td></tr>)}</tbody></table>{!items.length ? <Empty text="暂无行级错误" /> : null}</div>; }
function TraceInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <input aria-label={label} className="field min-w-0" placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} />; }
function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="min-w-0 rounded-md border border-cyan-100 bg-white p-4 shadow-sm"><h2 className="mb-4 flex items-center gap-2 font-semibold">{icon}{title}</h2>{children}</section>; }
function Small({ label, value }: { label: string; value: string | number }) { return <div className="min-w-0 rounded-md bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 truncate font-mono text-sm font-semibold">{value}</div></div>; }
function Metric({ label, value, icon, tone = "normal" }: { label: string; value: string; icon: React.ReactNode; tone?: "normal" | "warning" | "critical" }) { return <div className={`rounded-md border bg-white p-4 ${tone === "critical" ? "border-rose-300" : tone === "warning" ? "border-amber-300" : "border-cyan-100"}`}><div className="flex items-center justify-between text-xs text-slate-500"><span>{label}</span><span className="h-4 w-4 text-[#0f9f9b]">{icon}</span></div><div className="mt-2 text-xl font-semibold">{value}</div></div>; }
function Empty({ text }: { text: string }) { return <div className="flex min-h-28 w-full items-center justify-center text-center text-sm text-slate-400">{text}</div>; }
function statusLabel(status: string) { return ({ pending: "等待队列", processing: "处理中", completed: "全部完成", partial_success: "部分成功", failed: "失败" } as Record<string, string>)[status] ?? status; }

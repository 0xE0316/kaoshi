import fs from "node:fs";

import type { BatchPerformance, ImportTask, ImportTaskError, MonitorSummary } from "../src/lib/async-import-types";

async function main() {
const baseUrl = (process.env.LOAD_TEST_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ruleId = process.env.LOAD_TEST_RULE_ID;
const uploadRuns = Math.max(1, Number(process.env.LOAD_TEST_UPLOAD_RUNS ?? 5));
if (!ruleId) throw new Error("请设置 LOAD_TEST_RULE_ID 为已保存的通用表格规则 ID");

const filePath = "test-data/10000-orders.xlsx";
const fileBytes = fs.readFileSync(filePath);
const uploadSamples: number[] = [];
let taskId = "";
let traceId = "";
let serverErrors = 0;
let gatewayErrors = 0;
const totalStartedAt = performance.now();

for (let run = 0; run < uploadRuns; run += 1) {
  const file = new File([fileBytes], "10000-orders.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const form = new FormData();
  form.set("file", file);
  form.set("ruleId", ruleId);
  form.set("totalRows", "10000");
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/import-tasks`, { method: "POST", body: form });
  uploadSamples.push(performance.now() - startedAt);
  if (response.status === 500 || response.status === 504) gatewayErrors += 1;
  const created = await response.json() as { task_id?: string; trace_id?: string; error?: string };
  if (!response.ok || !created.task_id) throw new Error(`上传失败 HTTP ${response.status}: ${created.error ?? "unknown"}`);
  taskId ||= created.task_id;
  traceId ||= created.trace_id ?? "";
}

let task: ImportTask | null = null;
while (performance.now() - totalStartedAt < 120_000) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const response = await fetch(`${baseUrl}/api/import-tasks/${taskId}`, { cache: "no-store" });
  if (!response.ok) {
    serverErrors += 1;
    if (response.status === 500 || response.status === 504) gatewayErrors += 1;
    continue;
  }
  task = await response.json() as ImportTask;
  if (["completed", "partial_success", "failed"].includes(task.status)) break;
}

const [batchResponse, errorResponse, monitorResponse] = await Promise.all([
  fetch(`${baseUrl}/api/import-tasks/${taskId}/batches`, { cache: "no-store" }),
  fetch(`${baseUrl}/api/import-tasks/${taskId}/errors?page=1&page_size=100`, { cache: "no-store" }),
  fetch(`${baseUrl}/api/import-monitor/summary`, { cache: "no-store" }),
]);
for (const response of [batchResponse, errorResponse, monitorResponse]) {
  if (!response.ok) serverErrors += 1;
  if (response.status === 500 || response.status === 504) gatewayErrors += 1;
}

const batches = batchResponse.ok ? await batchResponse.json() as { performance: BatchPerformance[] } : { performance: [] };
const errors = errorResponse.ok ? await errorResponse.json() as { items: ImportTaskError[]; total: number } : { items: [], total: 0 };
const monitor = monitorResponse.ok ? await monitorResponse.json() as MonitorSummary : null;
const totalMs = performance.now() - totalStartedAt;
const uploadP95 = percentile(uploadSamples, 0.95);
const batchTotals = batches.performance.map((item) => item.totalDurationMs);
const validationTimes = batches.performance.map((item) => item.validateDurationMs);
const insertTimes = batches.performance.map((item) => item.insertDurationMs);
const errorRate = task ? task.failedRows / Math.max(1, task.totalRows) * 100 : 100;
const passed = Boolean(task && ["completed", "partial_success"].includes(task.status) && totalMs <= 60_000 && uploadP95 <= 1_000 && gatewayErrors === 0 && serverErrors === 0);

console.log(JSON.stringify({
  taskId,
  traceId,
  upload: { runs: uploadRuns, samplesMs: uploadSamples.map(Math.round), p95Ms: Math.round(uploadP95), targetMs: 1_000 },
  endToEnd: { totalMs: Math.round(totalMs), targetMs: 60_000 },
  task,
  batches: {
    count: batches.performance.length,
    totalMs: summarize(batchTotals),
    skuValidationMs: summarize(validationTimes),
    databaseInsertMs: summarize(insertTimes),
  },
  errors: { total: errors.total, ratePercent: Number(errorRate.toFixed(3)), sample: errors.items.slice(0, 10) },
  monitorSnapshot: monitor,
  databaseConnectionMetrics: "从同一测试时段的 Neon Monitoring 导出并附入压测报告",
  serverErrors,
  http500Or504: gatewayErrors,
  passed,
}, null, 2));

if (!passed) process.exitCode = 1;
}

function summarize(values: number[]) {
  return { p50: Math.round(percentile(values, 0.5)), p95: Math.round(percentile(values, 0.95)), p99: Math.round(percentile(values, 0.99)), max: Math.max(0, ...values) };
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

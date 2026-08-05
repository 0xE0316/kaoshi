# 智能多格式批量下单系统

Next.js 16 App Router + TypeScript + Neon PostgreSQL + QStash。系统保留原有多格式规则解析、AI 规则建议、在线预览与历史运单能力，并将正式下单主链路升级为异步事件驱动架构。

> 范围：文件上传、解析、规则引擎、校验、批量落库、任务进度、错误定位和监控。V3 审批、异常工单、品控暂扣、赔付和 Saga 不属于本项目范围。

## 本地启动

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run dev
```

访问 `http://localhost:3000`。导入下单与任务监控属于同一个系统，入口分别为 `/` 和 `/monitor`。

## 环境变量

```dotenv
DATABASE_URL=postgresql://...
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...
QSTASH_NEXT_SIGNING_KEY=...
CRON_SECRET=...
MIMO_API_KEY=...
MIMO_MODEL=mimo-v2.5-pro
```

本地联调 Worker 可临时设置 `ALLOW_UNSIGNED_WORKER=true`，生产环境无论该变量为何值都会强制验证 QStash 签名。

## 异步链路

1. `POST /api/import-tasks` 使用预览阶段已知的 `totalRows`，只保存文件并在同一事务创建任务和 `ImportTaskCreated` Outbox 事件后立即返回；完整解析只在 Worker 执行。
2. Dispatcher 将 Outbox 可靠投递到 QStash；投递失败指数退避，Cron 可恢复未投递事件。
3. Parse Worker 只解析一次原文件并复用现有规则引擎，将标准行批量暂存。
4. Parse Worker 创建每 500 行一个的 `ImportBatchCreated` Outbox 事件。
5. Batch Worker 一次批量查询 SKU，以集合 SQL 批量写回原有 `shipment_orders / shipment_rows`，失败行批量写错误表；历史查询继续复用原有运单数据源。
6. `task_id + unit_id` 唯一约束和状态原子抢占保证重复投递不重复处理；稳定行 ID 和外部编码唯一索引保证重试及并发任务不会重复下单。
7. 前端每 1.5 秒查询进度；监控页展示吞吐、积压、耗时分位、错误、慢批次和 Trace 时间线。

## API

- `POST /api/import-tasks`：`multipart/form-data`，字段 `file`、`ruleId`、`totalRows`，预览发生编辑时可带 `confirmedRows`。
- `GET /api/import-tasks/:taskId`：任务进度。
- `GET /api/import-tasks/:taskId/errors?batch=&error_code=&page=&page_size=`：错误分页。
- `GET /api/import-tasks/:taskId/batches`：批次及性能日志。
- `GET /api/import-tasks/:taskId/errors/export`：导出失败明细。
- `GET /api/traces/:traceId`：按 Trace 查询时间线与错误。
- `GET /api/traces?task_id=&trace_id=&file_name=&batch=&row_from=&row_to=&error_code=`：多维 Trace 检索。
- `GET /api/import-monitor/summary`：真实监控聚合。
- `GET|POST /api/import-dispatcher`：Outbox Dispatcher，生产使用 `CRON_SECRET`。
- `GET /api/import-cron/recover`：卡死批次恢复和补投递。

事件信封统一包含 `event_id`、`event_type`、`schema_version`、`aggregate_id`、`trace_id`、`occurred_at` 和 `payload`。已定义 `ImportTaskCreated`、`ImportBatchCreated`、`ImportBatchStarted`、`ImportBatchSucceeded`、`ImportBatchFailed`、`ImportTaskCompleted`、`ImportTaskPartialSuccess`、`ImportTaskDegraded`。新增字段保持向后兼容；重大语义变化升级 `schema_version`，消费者会校验必需字段并忽略未知字段。

## 压测

```bash
npm run seed:load-test
LOAD_TEST_RULE_ID=<已保存通用表格规则ID> LOAD_TEST_BASE_URL=http://localhost:3000 npm run load-test
npm run cleanup:load-test
```

`seed:load-test` 幂等 UPSERT 20,000 条 SKU，并生成 `test-data/10000-orders.xlsx`，其中每 997 行注入一个非法 SKU。仅需重新生成 Excel 时执行 `npm run seed:load-test:file`，不会访问数据库。`load-test` 默认采集 5 次上传样本并输出 P95，同时记录全链路耗时、批次 P50/P95/P99、SKU 校验、数据库写入、错误率、监控快照及 500/504 情况。测试完成后运行清理脚本。

## 验证

```bash
npm run lint
npm test
npm run build
```

部署前必须在目标数据库执行 `npm run db:migrate`。生产请求默认不执行 V4 DDL；仅紧急兼容时可显式设置 `ALLOW_RUNTIME_SCHEMA_MIGRATION=true`。Vercel 需配置每分钟调用 `/api/import-dispatcher`，每五分钟调用 `/api/import-cron/recover`。QStash 队列配置为批次并发 4、解析并发 2；监控页会显示队列、积压、死信、失败任务和慢批次告警。

详细设计见 [docs/V4-重构假设说明.md](docs/V4-重构假设说明.md)、[docs/V4-架构与接口.md](docs/V4-架构与接口.md) 和 [docs/V4-压测报告.md](docs/V4-压测报告.md)。

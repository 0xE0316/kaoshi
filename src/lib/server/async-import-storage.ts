import { createHash } from "node:crypto";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type {
  BatchPerformance, ImportBatchCreatedEvent, ImportErrorCode, ImportEventEnvelope,
  ImportEventPayloadMap, ImportEventType, ImportParseEventEnvelope, ImportTask,
  ImportTaskBatch, ImportTaskError, MonitorSummary, TraceEvent,
} from "@/lib/async-import-types";
import { finalImportTaskStatus, IMPORT_BATCH_SIZE } from "@/lib/async-import-types";
import type { ShipmentRow } from "@/lib/types";
import { makeId } from "@/lib/utils";
import { ensureV2Schema } from "@/lib/server/storage";

type Sql = NeonQueryFunction<false, false>;
let sqlClient: Sql | null = null;
let schemaPromise: Promise<void> | null = null;

function db() {
  if (sqlClient) return sqlClient;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("缺少 DATABASE_URL");
  sqlClient = neon(url);
  return sqlClient;
}

export async function ensureAsyncImportSchema(options: { force?: boolean } = {}) {
  if (process.env.NODE_ENV === "production" && !options.force && process.env.ALLOW_RUNTIME_SCHEMA_MIGRATION !== "true") {
    return;
  }
  if (schemaPromise) return schemaPromise;
  const sql = db();
  schemaPromise = (async () => {
    await ensureV2Schema();
    await sql`create table if not exists sku_master(id text primary key,sku_code text unique not null,name text not null,spec text not null,unit text not null,created_at timestamptz not null default now())`;
    await sql`create table if not exists import_tasks(id text primary key,file_name text not null,file_hash text not null,content_type text not null,file_data text not null,confirmed_rows jsonb,rule_id text not null,status text not null,total_rows integer not null,processed_rows integer not null default 0,success_rows integer not null default 0,failed_rows integer not null default 0,total_batches integer not null,completed_batches integer not null default 0,trace_id text unique not null,degraded boolean not null default false,degraded_reason text,recent_error text,parse_status text not null default 'pending',parse_retry_count integer not null default 0,parse_locked_at timestamptz,parse_duration_ms integer not null default 0,rule_duration_ms integer not null default 0,created_at timestamptz not null default now(),started_at timestamptz,completed_at timestamptz,last_heartbeat_at timestamptz)`;
    await sql`alter table import_tasks add column if not exists confirmed_rows jsonb`;
    await sql`alter table import_tasks add column if not exists parse_status text not null default 'pending'`;
    await sql`alter table import_tasks add column if not exists parse_retry_count integer not null default 0`;
    await sql`alter table import_tasks add column if not exists parse_locked_at timestamptz`;
    await sql`create table if not exists import_task_batches(id text primary key,task_id text not null references import_tasks(id) on delete cascade,unit_id text not null,batch_index integer not null,start_row integer not null,end_row integer not null,status text not null default 'pending',retry_count integer not null default 0,success_rows integer not null default 0,failed_rows integer not null default 0,locked_at timestamptz,completed_at timestamptz,last_error text,unique(task_id,unit_id))`;
    await sql`create table if not exists import_task_errors(id text primary key,task_id text not null references import_tasks(id) on delete cascade,unit_id text not null,batch_index integer not null,row_number integer not null,field_name text not null,raw_value text not null,error_code text not null,error_reason text not null,suggestion text not null,rule_id text not null,trace_id text not null,created_at timestamptz not null default now())`;
    await sql`create table if not exists event_outbox(id text primary key,aggregate_id text not null,event_type text not null,payload jsonb not null,status text not null default 'pending',retry_count integer not null default 0,next_retry_at timestamptz not null default now(),last_error text,created_at timestamptz not null default now(),sent_at timestamptz)`;
    await sql`create table if not exists batch_performance_log(id text primary key,task_id text not null,unit_id text not null,batch_index integer not null,parse_duration_ms integer not null,rule_duration_ms integer not null,validate_duration_ms integer not null,insert_duration_ms integer not null,total_duration_ms integer not null,status text not null,retry_count integer not null,trace_id text not null,created_at timestamptz not null default now(),unique(task_id,unit_id))`;
    await sql`create table if not exists trace_events(id text primary key,trace_id text not null,task_id text not null,unit_id text,event_name text not null,event_status text not null,message text not null,metadata jsonb not null default '{}'::jsonb,occurred_at timestamptz not null default now())`;
    await sql`create table if not exists import_staged_rows(task_id text not null references import_tasks(id) on delete cascade,row_number integer not null,payload jsonb not null,primary key(task_id,row_number))`;
    await sql`create index if not exists import_tasks_status_created_idx on import_tasks(status,created_at desc)`;
    await sql`create index if not exists import_batches_task_status_idx on import_task_batches(task_id,status)`;
    await sql`create index if not exists import_errors_task_unit_idx on import_task_errors(task_id,unit_id)`;
    await sql`create index if not exists import_errors_code_idx on import_task_errors(error_code)`;
    await sql`create index if not exists outbox_dispatch_idx on event_outbox(status,next_retry_at)`;
    await sql`create index if not exists performance_task_unit_idx on batch_performance_log(task_id,unit_id)`;
    await sql`create index if not exists trace_lookup_idx on trace_events(trace_id,occurred_at)`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function lifecycleEvent<T extends ImportEventType>(input: {
  eventType: T;
  taskId: string;
  traceId: string;
  payload: ImportEventPayloadMap[T];
}): ImportEventEnvelope<T> {
  return {
    event_id: makeId("evt"),
    event_type: input.eventType,
    schema_version: 1,
    aggregate_id: input.taskId,
    trace_id: input.traceId,
    occurred_at: new Date().toISOString(),
    payload: input.payload,
  };
}

export async function createImportTask(input: { id: string; traceId: string; fileName: string; fileHash: string; contentType: string; fileData: string; confirmedRows?: ShipmentRow[]; ruleId: string; totalRows: number; batches: Array<{ unitId: string; batchIndex: number; startRow: number; endRow: number }> }) {
  await ensureAsyncImportSchema();
  const sql = db();
  const createdAt = new Date().toISOString();
  const parseEvent: ImportParseEventEnvelope = lifecycleEvent({ eventType: "ImportTaskCreated", taskId: input.id, traceId: input.traceId, payload: { task_id: input.id } });
  const statements: ReturnType<Sql>[] = [
    sql`insert into import_tasks(id,file_name,file_hash,content_type,file_data,confirmed_rows,rule_id,status,total_rows,total_batches,trace_id,created_at) values(${input.id},${input.fileName},${input.fileHash},${input.contentType},${input.fileData},${input.confirmedRows ? JSON.stringify(input.confirmedRows) : null}::jsonb,${input.ruleId},'pending',${input.totalRows},${input.batches.length},${input.traceId},${createdAt}::timestamptz)`,
    sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${input.traceId},${input.id},'ImportTaskCreated','info','用户上传文件，异步任务已创建',${JSON.stringify({ envelope: parseEvent, fileName: input.fileName, totalRows: input.totalRows })}::jsonb)`,
    sql`insert into event_outbox(id,aggregate_id,event_type,payload) values(${parseEvent.event_id},${input.id},${parseEvent.event_type},${JSON.stringify(parseEvent)}::jsonb)`,
  ];
  for (const batch of input.batches) statements.push(sql`insert into import_task_batches(id,task_id,unit_id,batch_index,start_row,end_row) values(${makeId("batch")},${input.id},${batch.unitId},${batch.batchIndex},${batch.startRow},${batch.endRow})`);
  await sql.transaction(() => statements);
  return {
    id: input.id,
    fileName: input.fileName,
    fileHash: input.fileHash,
    ruleId: input.ruleId,
    status: "pending" as const,
    totalRows: input.totalRows,
    processedRows: 0,
    successRows: 0,
    failedRows: 0,
    totalBatches: input.batches.length,
    completedBatches: 0,
    traceId: input.traceId,
    degraded: false,
    degradedReason: null,
    createdAt,
    startedAt: null,
    completedAt: null,
    lastHeartbeatAt: null,
    recentError: null,
    throughputPerMinute: 0,
    estimatedSecondsRemaining: null,
  } satisfies ImportTask;
}

export async function findRecentTaskByHash(fileHash: string, ruleId: string) {
  await ensureAsyncImportSchema();
  const rows = await db()`select * from import_tasks where file_hash=${fileHash} and rule_id=${ruleId} and created_at>now()-interval '10 minutes' and status<>'failed' order by created_at desc limit 1`;
  return rows.length ? mapTask(rows[0]) : null;
}

export async function getImportTask(id: string): Promise<ImportTask | null> {
  await ensureAsyncImportSchema();
  const rows = await db()`select * from import_tasks where id=${id}`;
  return rows.length ? mapTask(rows[0]) : null;
}

export async function getImportSource(taskId: string) {
  await ensureAsyncImportSchema();
  const rows = await db()`select file_name,content_type,file_data,confirmed_rows,rule_id,trace_id,total_rows,parse_duration_ms,rule_duration_ms from import_tasks where id=${taskId}`;
  return rows[0] ?? null;
}

export async function claimFileParse(taskId: string) {
  await ensureAsyncImportSchema();
  const rows = await db()`update import_tasks set parse_status='processing',parse_retry_count=parse_retry_count+1,parse_locked_at=now(),status='processing',started_at=coalesce(started_at,now()),last_heartbeat_at=now() where id=${taskId} and parse_status in('pending','failed') and parse_retry_count<3 and status not in('completed','partial_success','failed') returning id`;
  return rows.length > 0;
}

export async function failFileParse(taskId: string, traceId: string, message: string) {
  await ensureAsyncImportSchema();
  const sql = db();
  const rows = await sql`update import_tasks set parse_status='failed',status=case when parse_retry_count>=3 then 'failed' else 'pending' end,recent_error=${message},completed_at=case when parse_retry_count>=3 then now() else null end,last_heartbeat_at=now() where id=${taskId} returning parse_retry_count,status`;
  if (!rows.length) return;
  const terminal = String(rows[0].status) === "failed";
  await sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${traceId},${taskId},'ImportFileParseFailed','error',${message},${JSON.stringify({ retryCount: Number(rows[0].parse_retry_count), terminal })}::jsonb)`;
}

export async function stageParsedRows(taskId: string, traceId: string, rows: ShipmentRow[], durations: { parseDurationMs: number; ruleDurationMs: number }) {
  await ensureAsyncImportSchema();
  const sql = db();
  const existing = await sql`select count(*)::int count from import_staged_rows where task_id=${taskId}`;
  if (Number(existing[0]?.count) > 0) return { staged: Number(existing[0].count), duplicate: true };
  const records = rows.map((row, index) => ({ task_id: taskId, row_number: index + 1, payload: row }));
  const batches = Array.from({ length: Math.ceil(rows.length / IMPORT_BATCH_SIZE) }, (_, index) => ({
    unitId: `unit_${String(index + 1).padStart(4, "0")}`,
    batchIndex: index + 1,
    startRow: index * IMPORT_BATCH_SIZE + 1,
    endRow: Math.min(rows.length, (index + 1) * IMPORT_BATCH_SIZE),
  }));
  const statements: ReturnType<Sql>[] = [];
  statements.push(sql`delete from import_task_batches where task_id=${taskId}`);
  for (const batch of batches) {
    statements.push(sql`insert into import_task_batches(id,task_id,unit_id,batch_index,start_row,end_row) values(${makeId("batch")},${taskId},${batch.unitId},${batch.batchIndex},${batch.startRow},${batch.endRow})`);
  }
  if (!rows.length) {
    statements.push(sql`update import_tasks set total_rows=0,total_batches=0,status='failed',parse_status='failed',recent_error='规则未解析出可处理的数据',completed_at=now(),parse_duration_ms=${durations.parseDurationMs},rule_duration_ms=${durations.ruleDurationMs},last_heartbeat_at=now() where id=${taskId}`);
    statements.push(sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${traceId},${taskId},'ImportFileParsed','error','规则未解析出可处理的数据',${JSON.stringify(durations)}::jsonb)`);
    await sql.transaction(() => statements);
    return { staged: 0, duplicate: false };
  }
  statements.push(sql`update import_tasks set total_rows=${rows.length},total_batches=${batches.length},parse_status='completed',parse_duration_ms=${durations.parseDurationMs},rule_duration_ms=${durations.ruleDurationMs},last_heartbeat_at=now() where id=${taskId}`);
  if (records.length) statements.push(sql`insert into import_staged_rows(task_id,row_number,payload) select x.task_id,x.row_number,x.payload from jsonb_to_recordset(${JSON.stringify(records)}::jsonb) as x(task_id text,row_number int,payload jsonb)`);
  for (const batch of batches) {
    const event: ImportBatchCreatedEvent = lifecycleEvent({ eventType: "ImportBatchCreated", taskId, traceId, payload: { task_id: taskId, unit_id: batch.unitId, batch_index: batch.batchIndex, start_row: batch.startRow, end_row: batch.endRow } });
    statements.push(sql`insert into event_outbox(id,aggregate_id,event_type,payload) values(${event.event_id},${taskId},${event.event_type},${JSON.stringify(event)}::jsonb)`);
  }
  statements.push(sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${traceId},${taskId},'ImportFileParsed','success',${`文件完成一次解析，暂存 ${rows.length} 行`},${JSON.stringify({ rowCount: rows.length, batchCount: batches.length, ...durations })}::jsonb)`);
  await sql.transaction(() => statements);
  return { staged: rows.length, duplicate: false };
}

export async function getStagedRows(taskId: string, startRow: number, endRow: number) {
  await ensureAsyncImportSchema();
  const rows = await db()`select row_number,payload from import_staged_rows where task_id=${taskId} and row_number between ${startRow} and ${endRow} order by row_number`;
  return rows.map((item) => ({ row: item.payload as ShipmentRow, rowNumber: Number(item.row_number) }));
}

export async function claimBatch(taskId: string, unitId: string) {
  await ensureAsyncImportSchema();
  const sql = db();
  const rows = await sql`update import_task_batches set status='processing',locked_at=now(),retry_count=retry_count+1 where task_id=${taskId} and unit_id=${unitId} and status in('pending','failed') and retry_count<3 returning *`;
  if (!rows.length) return null;
  await sql`update import_tasks set status='processing',started_at=coalesce(started_at,now()),last_heartbeat_at=now() where id=${taskId}`;
  return mapBatch(rows[0]);
}

export async function getBatch(taskId: string, unitId: string) {
  await ensureAsyncImportSchema();
  const rows = await db()`select * from import_task_batches where task_id=${taskId} and unit_id=${unitId}`;
  return rows.length ? mapBatch(rows[0]) : null;
}

export async function batchSkuLookup(codes: string[], timeoutMs = 3_000) {
  if (!codes.length) return new Set<string>();
  const query = db()`select sku_code from sku_master where sku_code in(select jsonb_array_elements_text(${JSON.stringify([...new Set(codes)])}::jsonb))`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([query, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SKU_LOOKUP_TIMEOUT")), timeoutMs); })]);
    return new Set(rows.map((row) => String(row.sku_code)));
  } finally { if (timer) clearTimeout(timer); }
}

export async function existingExternalCodes(codes: string[], currentTaskId?: string) {
  if (!codes.length) return new Set<string>();
  await ensureAsyncImportSchema();
  const rows = await db()`select distinct external_code from shipment_orders where external_code in(select jsonb_array_elements_text(${JSON.stringify([...new Set(codes.filter(Boolean))])}::jsonb)) and (${currentTaskId ?? null}::text is null or batch_id<>${currentTaskId ?? null})`;
  return new Set(rows.map((row) => String(row.external_code)));
}

export async function currentTaskOrderReceivers(taskId: string, codes: string[]) {
  if (!codes.length) return new Map<string, string>();
  await ensureAsyncImportSchema();
  const rows = await db()`select external_code,store_name,recipient_name,recipient_phone,recipient_address from shipment_orders where batch_id=${taskId} and external_code in(select jsonb_array_elements_text(${JSON.stringify([...new Set(codes.filter(Boolean))])}::jsonb))`;
  return new Map(rows.map((row) => [
    String(row.external_code),
    [row.store_name, row.recipient_name, row.recipient_phone, row.recipient_address].map((value) => String(value ?? "").trim()).join("|"),
  ]));
}

type AsyncOrderPayload = {
  id: string;
  external_code: string | null;
  store_name: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
};

function stableOrderId(taskId: string, key: string) {
  const digest = createHash("sha256").update(`${taskId}:${key}`).digest("hex").slice(0, 32);
  return `${taskId}:order:${digest}`;
}

function makeOrderPayload(taskId: string, rows: Array<{ row: ShipmentRow; rowNumber: number }>) {
  const grouped = new Map<string, { order: AsyncOrderPayload; rowIds: string[] }>();
  for (const item of rows) {
    const externalCode = item.row.externalCode.trim() || null;
    const key = externalCode ?? `row:${item.row.id}`;
    const current = grouped.get(key);
    if (current) {
      current.rowIds.push(item.row.id);
      continue;
    }
    grouped.set(key, {
      order: {
        id: stableOrderId(taskId, key),
        external_code: externalCode,
        store_name: item.row.storeName,
        recipient_name: item.row.recipientName,
        recipient_phone: item.row.recipientPhone,
        recipient_address: item.row.recipientAddress,
      },
      rowIds: [item.row.id],
    });
  }
  return Array.from(grouped.values()).map(({ order, rowIds }) => ({ ...order, row_ids: rowIds }));
}

async function persistRowsToV2(input: {
  taskId: string;
  fileName: string;
  ruleId: string;
  totalRows: number;
  rows: Array<{ row: ShipmentRow; rowNumber: number }>;
}) {
  const sql = db();
  const rowPayload = input.rows.map(({ row, rowNumber }) => ({
    id: `${input.taskId}:${rowNumber}`,
    order_id: stableOrderId(input.taskId, row.externalCode.trim() || `row:${row.id}`),
    row_number: rowNumber,
    external_code: row.externalCode.trim() || null,
    store_name: row.storeName,
    recipient_name: row.recipientName,
    recipient_phone: row.recipientPhone,
    recipient_address: row.recipientAddress,
    sku_code: row.skuCode,
    sku_name: row.skuName,
    sku_qty: row.skuQty,
    sku_spec: row.skuSpec,
    temperature_zone: row.temperatureZone,
    remark: row.remark,
    payload: row,
  }));
  const orderPayload = makeOrderPayload(input.taskId, input.rows);
  const result = await sql`
    with incoming_orders as (
      select x.id, x.external_code, x.store_name, x.recipient_name, x.recipient_phone, x.recipient_address
      from jsonb_to_recordset(${JSON.stringify(orderPayload)}::jsonb) as x(
        id text,
        external_code text,
        store_name text,
        recipient_name text,
        recipient_phone text,
        recipient_address text,
        row_ids jsonb
      )
    ),
    ensure_batch as (
      insert into import_batches(id, file_name, rule_id, row_count, success_count, failed_count)
      values(${input.taskId}, ${input.fileName}, ${input.ruleId}, ${input.totalRows}, 0, 0)
      on conflict(id) do update set file_name=excluded.file_name, rule_id=excluded.rule_id, row_count=excluded.row_count
      returning id
    ),
    accepted_orders as (
      insert into shipment_orders(
        id, batch_id, external_code, store_name, recipient_name, recipient_phone,
        recipient_address, sku_count, total_qty, row_ids, payload
      )
      select
        io.id,
        ${input.taskId},
        io.external_code,
        io.store_name,
        io.recipient_name,
        io.recipient_phone,
        io.recipient_address,
        0,
        0,
        '[]'::jsonb,
        jsonb_build_object(
          'id', io.id,
          'externalCode', io.external_code,
          'storeName', io.store_name,
          'recipientName', io.recipient_name,
          'recipientPhone', io.recipient_phone,
          'recipientAddress', io.recipient_address,
          'skuCount', 0,
          'totalQty', 0,
          'rowIds', '[]'::jsonb
        )
      from incoming_orders io
      cross join ensure_batch
      on conflict (external_code) where external_code is not null and external_code <> '' do update set id=shipment_orders.id
      where shipment_orders.batch_id=${input.taskId}
        and coalesce(shipment_orders.store_name, '')=coalesce(excluded.store_name, '')
        and coalesce(shipment_orders.recipient_name, '')=coalesce(excluded.recipient_name, '')
        and coalesce(shipment_orders.recipient_phone, '')=coalesce(excluded.recipient_phone, '')
        and coalesce(shipment_orders.recipient_address, '')=coalesce(excluded.recipient_address, '')
      returning id, external_code
    ),
    incoming_rows as (
      select x.id, x.order_id, x.row_number, x.external_code, x.store_name, x.recipient_name,
        x.recipient_phone, x.recipient_address, x.sku_code, x.sku_name, x.sku_qty,
        x.sku_spec, x.temperature_zone, x.remark, x.payload
      from jsonb_to_recordset(${JSON.stringify(rowPayload)}::jsonb) as x(
        id text,
        order_id text,
        row_number integer,
        external_code text,
        store_name text,
        recipient_name text,
        recipient_phone text,
        recipient_address text,
        sku_code text,
        sku_name text,
        sku_qty text,
        sku_spec text,
        temperature_zone text,
        remark text,
        payload jsonb
      )
    ),
    new_row_data as (
      select ir.*
      from incoming_rows ir
      join accepted_orders ao on ao.id=ir.order_id
      where not exists(select 1 from shipment_rows existing where existing.id=ir.id)
    ),
    inserted_rows as (
      insert into shipment_rows(
        id, batch_id, source_file_name, external_code, store_name, recipient_name,
        recipient_phone, recipient_address, sku_code, sku_name, sku_qty, sku_spec,
        temperature_zone, remark, payload
      )
      select
        id, ${input.taskId}, ${input.fileName}, external_code, store_name, recipient_name,
        recipient_phone, recipient_address, sku_code, sku_name, nullif(sku_qty, '')::numeric,
        sku_spec, temperature_zone, remark, payload
      from new_row_data
      on conflict(id) do nothing
      returning id
    ),
    new_orders as (
      select n.order_id,
        count(*)::integer as sku_count,
        coalesce(sum(nullif(n.sku_qty, '')::numeric), 0) as total_qty,
        jsonb_agg(n.id order by n.row_number) as row_ids
      from new_row_data n
      join inserted_rows ir on ir.id=n.id
      group by n.order_id
    ),
    updated_orders as (
      update shipment_orders so
      set sku_count=so.sku_count+new_orders.sku_count,
        total_qty=so.total_qty+new_orders.total_qty,
        row_ids=so.row_ids||new_orders.row_ids,
        payload=jsonb_build_object(
          'id', so.id,
          'externalCode', so.external_code,
          'storeName', so.store_name,
          'recipientName', so.recipient_name,
          'recipientPhone', so.recipient_phone,
          'recipientAddress', so.recipient_address,
          'skuCount', so.sku_count+new_orders.sku_count,
          'totalQty', so.total_qty+new_orders.total_qty,
          'rowIds', so.row_ids||new_orders.row_ids
        )
      from new_orders
      where so.id=new_orders.order_id
      returning so.id
    )
    select
      coalesce((
        select jsonb_agg(io.external_code order by io.external_code)
        from incoming_orders io
        where io.external_code is not null
          and not exists(select 1 from accepted_orders ao where ao.external_code=io.external_code)
      ), '[]'::jsonb) as rejected_codes,
      (select count(*)::integer from inserted_rows) as inserted_rows
  `;
  const rejectedValue = result[0]?.rejected_codes;
  const rejectedExternalCodes = Array.isArray(rejectedValue)
    ? rejectedValue.map(String)
    : typeof rejectedValue === "string"
      ? (JSON.parse(rejectedValue) as unknown[]).map(String)
      : [];
  return { rejectedExternalCodes, insertedRows: Number(result[0]?.inserted_rows ?? 0) };
}

export async function completeBatch(input: { taskId: string; unitId: string; traceId: string; batchIndex: number; fileName: string; ruleId: string; totalRows: number; rows: Array<{ row: ShipmentRow; rowNumber: number }>; errors: Omit<ImportTaskError, "id" | "createdAt">[]; performance: Omit<BatchPerformance, "status" | "retryCount">; degraded: boolean; degradedReason?: string }) {
  await ensureAsyncImportSchema();
  const sql = db();
  const initialBlockingRows = new Set(input.errors.filter((error) => error.errorCode !== "E009").map((error) => error.rowNumber));
  const initialSuccessful = input.rows.filter((item) => !initialBlockingRows.has(item.rowNumber));
  const persistStarted = Date.now();
  const persisted = await persistRowsToV2({ taskId: input.taskId, fileName: input.fileName, ruleId: input.ruleId, totalRows: input.totalRows, rows: initialSuccessful });
  const insertDurationMs = Date.now() - persistStarted;
  const raceErrorRecords = input.rows
    .filter(({ row }) => row.externalCode.trim() && persisted.rejectedExternalCodes.includes(row.externalCode.trim()))
    .filter(({ rowNumber }) => !input.errors.some((error) => error.rowNumber === rowNumber && error.errorCode === "E005"))
    .map(({ row, rowNumber }): Omit<ImportTaskError, "id" | "createdAt"> => ({
      taskId: input.taskId,
      unitId: input.unitId,
      batchIndex: input.batchIndex,
      rowNumber,
      fieldName: "externalCode",
      rawValue: row.externalCode.slice(0, 200),
      errorCode: "E005",
      errorReason: "外部编码已被其他任务占用，或同一编码的收货信息不一致",
      suggestion: "请核实外部编码，并统一同一出库单的收货信息后重新导入",
      ruleId: input.ruleId,
      traceId: input.traceId,
    }));
  const allErrors = [...input.errors, ...raceErrorRecords].filter((error, index, errors) => {
    const key = `${error.rowNumber}:${error.errorCode}:${error.fieldName}`;
    return errors.findIndex((candidate) => `${candidate.rowNumber}:${candidate.errorCode}:${candidate.fieldName}` === key) === index;
  });
  const blockingRows = new Set(allErrors.filter((error) => error.errorCode !== "E009").map((error) => error.rowNumber));
  const successful = input.rows.filter((item) => !blockingRows.has(item.rowNumber));
  const errorPayload = allErrors.map((error) => ({ id: makeId("error"), task_id: error.taskId, unit_id: error.unitId, batch_index: error.batchIndex, row_number: error.rowNumber, field_name: error.fieldName, raw_value: error.rawValue, error_code: error.errorCode, error_reason: error.errorReason, suggestion: error.suggestion, rule_id: error.ruleId, trace_id: error.traceId }));
  const performance = { ...input.performance, insertDurationMs, totalDurationMs: input.performance.totalDurationMs + insertDurationMs };
  const succeededEvent = lifecycleEvent({
    eventType: "ImportBatchSucceeded",
    taskId: input.taskId,
    traceId: input.traceId,
    payload: { task_id: input.taskId, unit_id: input.unitId, batch_index: input.batchIndex, success_rows: successful.length, failed_rows: input.rows.length - successful.length },
  });
  const degradedEvent = input.degraded ? lifecycleEvent({
    eventType: "ImportTaskDegraded",
    taskId: input.taskId,
    traceId: input.traceId,
    payload: { task_id: input.taskId, unit_id: input.unitId, batch_index: input.batchIndex, reason: input.degradedReason ?? "SKU 主数据查询超时或失败" },
  }) : null;
  const statements: ReturnType<Sql>[] = [];
  if (errorPayload.length) statements.push(sql`insert into import_task_errors(id,task_id,unit_id,batch_index,row_number,field_name,raw_value,error_code,error_reason,suggestion,rule_id,trace_id) select x.id,x.task_id,x.unit_id,x.batch_index,x.row_number,x.field_name,x.raw_value,x.error_code,x.error_reason,x.suggestion,x.rule_id,x.trace_id from jsonb_to_recordset(${JSON.stringify(errorPayload)}::jsonb) as x(id text,task_id text,unit_id text,batch_index int,row_number int,field_name text,raw_value text,error_code text,error_reason text,suggestion text,rule_id text,trace_id text)`);
  statements.push(sql`update import_tasks set processed_rows=processed_rows+${input.rows.length},success_rows=success_rows+${successful.length},failed_rows=failed_rows+${input.rows.length-successful.length},completed_batches=completed_batches+1,degraded=degraded or ${input.degraded},degraded_reason=case when ${input.degraded} then ${input.degradedReason ?? "SKU 主数据查询超时或失败"} else degraded_reason end,last_heartbeat_at=now() where id=${input.taskId} and exists(select 1 from import_task_batches where task_id=${input.taskId} and unit_id=${input.unitId} and status='processing')`);
  statements.push(sql`update import_task_batches set status='completed',success_rows=${successful.length},failed_rows=${input.rows.length-successful.length},completed_at=now(),last_error=null where task_id=${input.taskId} and unit_id=${input.unitId} and status='processing'`);
  statements.push(sql`update import_batches set success_count=(select success_rows from import_tasks where id=${input.taskId}),failed_count=(select failed_rows from import_tasks where id=${input.taskId}) where id=${input.taskId}`);
  statements.push(sql`insert into batch_performance_log(id,task_id,unit_id,batch_index,parse_duration_ms,rule_duration_ms,validate_duration_ms,insert_duration_ms,total_duration_ms,status,retry_count,trace_id) values(${makeId("perf")},${input.taskId},${input.unitId},${input.batchIndex},${performance.parseDurationMs},${performance.ruleDurationMs},${performance.validateDurationMs},${performance.insertDurationMs},${performance.totalDurationMs},'completed',1,${input.traceId}) on conflict(task_id,unit_id) do update set validate_duration_ms=excluded.validate_duration_ms,insert_duration_ms=excluded.insert_duration_ms,total_duration_ms=excluded.total_duration_ms,status='completed'`);
  statements.push(sql`insert into trace_events(id,trace_id,task_id,unit_id,event_name,event_status,message,metadata) values(${makeId("trace")},${input.traceId},${input.taskId},${input.unitId},'ImportBatchSucceeded',${input.degraded ? "warning" : "success"},${`批次 ${input.batchIndex} 完成：成功 ${successful.length}，失败 ${input.rows.length-successful.length}`},${JSON.stringify({ envelope: succeededEvent, ...performance, insertedRows: persisted.insertedRows })}::jsonb)`);
  if (degradedEvent) statements.push(sql`insert into trace_events(id,trace_id,task_id,unit_id,event_name,event_status,message,metadata) values(${makeId("trace")},${input.traceId},${input.taskId},${input.unitId},'ImportTaskDegraded','warning',${degradedEvent.payload.reason},${JSON.stringify({ envelope: degradedEvent })}::jsonb)`);
  await sql.transaction(() => statements);
  return finalizeTask(input.taskId, input.traceId);
}

export async function failBatch(taskId: string, unitId: string, traceId: string, message: string, retryable = true) {
  const batch = await getBatch(taskId, unitId);
  if (!batch || batch.status === "completed") return;
  const terminal = !retryable || batch.retryCount >= 3;
  const sql = db();
  const event = lifecycleEvent({ eventType: "ImportBatchFailed", taskId, traceId, payload: { task_id: taskId, unit_id: unitId, batch_index: batch.batchIndex, retry_count: batch.retryCount, retryable: retryable && !terminal, reason: message } });
  await sql.transaction((tx) => [
    tx`update import_task_batches set status='failed',last_error=${message},completed_at=${terminal ? new Date().toISOString() : null} where task_id=${taskId} and unit_id=${unitId}`,
    tx`update import_tasks set recent_error=${message},last_heartbeat_at=now(),status=${terminal ? "failed" : "processing"},completed_at=${terminal ? new Date().toISOString() : null} where id=${taskId}`,
    tx`insert into trace_events(id,trace_id,task_id,unit_id,event_name,event_status,message,metadata) values(${makeId("trace")},${traceId},${taskId},${unitId},'ImportBatchFailed','error',${message},${JSON.stringify({ envelope: event, retryable: retryable && !terminal, retryCount: batch.retryCount })}::jsonb)`,
  ]);
}

async function finalizeTask(taskId: string, traceId: string) {
  const sql = db();
  const rows = await sql`select total_batches,completed_batches,success_rows,failed_rows,status from import_tasks where id=${taskId}`;
  if (Number(rows[0].completed_batches) < Number(rows[0].total_batches)) return getImportTask(taskId);
  if (["completed", "partial_success", "failed"].includes(String(rows[0].status))) return getImportTask(taskId);
  const status = finalImportTaskStatus(Number(rows[0].success_rows), Number(rows[0].failed_rows));
  const updated = await sql`update import_tasks set status=${status},completed_at=now(),last_heartbeat_at=now() where id=${taskId} and status not in('completed','partial_success','failed') and completed_batches>=total_batches returning id`;
  if (updated.length) {
    const event = status === "completed"
      ? lifecycleEvent({ eventType: "ImportTaskCompleted", taskId, traceId, payload: { task_id: taskId } })
      : status === "partial_success"
        ? lifecycleEvent({ eventType: "ImportTaskPartialSuccess", taskId, traceId, payload: { task_id: taskId, failed_rows: Number(rows[0].failed_rows) } })
        : lifecycleEvent({ eventType: "ImportTaskFailed", taskId, traceId, payload: { task_id: taskId, failed_rows: Number(rows[0].failed_rows), reason: "所有导入行均校验失败" } });
    await sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${traceId},${taskId},${event.event_type},${status === "completed" ? "success" : status === "partial_success" ? "warning" : "error"},${status === "completed" ? "任务全部完成" : status === "partial_success" ? "任务部分成功，请查看错误明细" : "所有导入行均失败，请查看错误明细"},${JSON.stringify({ envelope: event })}::jsonb)`;
  }
  return getImportTask(taskId);
}

export async function listOutbox(limit = 50) { await ensureAsyncImportSchema(); return db()`select * from event_outbox where status in('pending','failed') and next_retry_at<=now() and retry_count<5 order by created_at limit ${limit}`; }
export async function markOutboxSent(id: string) { await db()`update event_outbox set status='sent',sent_at=now(),last_error=null where id=${id}`; }
export async function markOutboxFailed(id: string, error: string) { await db()`update event_outbox set status='failed',retry_count=retry_count+1,last_error=${error},next_retry_at=now()+(least(60,power(2,retry_count+1))::text||' seconds')::interval where id=${id}`; }
export async function addTrace(input: { traceId: string; taskId: string; unitId?: string; eventName: string; status: TraceEvent["eventStatus"]; message: string; metadata?: Record<string, unknown> }) { await ensureAsyncImportSchema(); await db()`insert into trace_events(id,trace_id,task_id,unit_id,event_name,event_status,message,metadata) values(${makeId("trace")},${input.traceId},${input.taskId},${input.unitId ?? null},${input.eventName},${input.status},${input.message},${JSON.stringify(input.metadata ?? {})}::jsonb)`; }

export async function addLifecycleTrace<T extends ImportEventType>(input: {
  eventType: T;
  taskId: string;
  traceId: string;
  unitId?: string;
  payload: ImportEventPayloadMap[T];
  status: TraceEvent["eventStatus"];
  message: string;
  metadata?: Record<string, unknown>;
}) {
  const event = lifecycleEvent(input);
  return addTrace({ ...input, eventName: event.event_type, metadata: { envelope: event, ...input.metadata } });
}

export async function listTaskErrors(taskId: string, filters: { batch?: number; errorCode?: string; page: number; pageSize: number }) {
  await ensureAsyncImportSchema(); const offset = (filters.page - 1) * filters.pageSize;
  const rows = await db()`select *,count(*) over() total_count from import_task_errors where task_id=${taskId} and (${filters.batch ?? null}::int is null or batch_index=${filters.batch ?? null}) and (${filters.errorCode ?? null}::text is null or error_code=${filters.errorCode ?? null}) order by row_number limit ${filters.pageSize} offset ${offset}`;
  return { items: rows.map(mapError), total: Number(rows[0]?.total_count ?? 0), page: filters.page, pageSize: filters.pageSize };
}

export async function listTaskBatches(taskId: string) {
  await ensureAsyncImportSchema(); const [batches, performance] = await Promise.all([db()`select * from import_task_batches where task_id=${taskId} order by batch_index`, db()`select * from batch_performance_log where task_id=${taskId} order by batch_index`]);
  return { batches: batches.map(mapBatch), performance: performance.map(mapPerformance) };
}

export async function searchTrace(params: { traceId?: string; taskId?: string; fileName?: string; batch?: number; rowFrom?: number; rowTo?: number; errorCode?: string }) {
  await ensureAsyncImportSchema();
  const tasks = await db()`
    select t.id,t.trace_id,t.file_name
    from import_tasks t
    where (${params.traceId ?? null}::text is null or t.trace_id=${params.traceId ?? null})
      and (${params.taskId ?? null}::text is null or t.id=${params.taskId ?? null})
      and (${params.fileName ?? null}::text is null or t.file_name ilike ${params.fileName ? `%${params.fileName}%` : null})
      and (${params.batch ?? null}::int is null or exists(select 1 from import_task_batches b where b.task_id=t.id and b.batch_index=${params.batch ?? null}))
      and ((${params.rowFrom ?? null}::int is null and ${params.rowTo ?? null}::int is null and ${params.errorCode ?? null}::text is null) or exists(
        select 1 from import_task_errors e where e.task_id=t.id
          and (${params.rowFrom ?? null}::int is null or e.row_number>=${params.rowFrom ?? null})
          and (${params.rowTo ?? null}::int is null or e.row_number<=${params.rowTo ?? null})
          and (${params.errorCode ?? null}::text is null or e.error_code=${params.errorCode ?? null})
      ))
    order by t.created_at desc limit 20`;
  const ids = tasks.map((row) => String(row.id)); if (!ids.length) return { tasks: [], events: [], errors: [] };
  const events = await db()`select e.* from trace_events e where e.task_id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) and (${params.batch ?? null}::int is null or e.unit_id is null or exists(select 1 from import_task_batches b where b.task_id=e.task_id and b.unit_id=e.unit_id and b.batch_index=${params.batch ?? null})) order by e.occurred_at`;
  const errors = await db()`select * from import_task_errors where task_id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) and (${params.batch ?? null}::int is null or batch_index=${params.batch ?? null}) and (${params.rowFrom ?? null}::int is null or row_number>=${params.rowFrom ?? null}) and (${params.rowTo ?? null}::int is null or row_number<=${params.rowTo ?? null}) and (${params.errorCode ?? null}::text is null or error_code=${params.errorCode ?? null}) order by created_at`;
  return { tasks, events: events.map(mapTrace), errors: errors.map(mapError) };
}

export async function monitorSummary(): Promise<MonitorSummary> {
  await ensureAsyncImportSchema(); const sql = db();
  const [queue, throughput, taskPerf, batchPerf, errors, slow, failed, deadLetters, recentQueueFailures] = await Promise.all([
    sql`select count(*)::int batches,coalesce(sum(end_row-start_row+1),0)::int rows from import_task_batches where status in('pending','processing')`,
    sql`select date_trunc('minute',completed_at) as time_bucket,sum(success_rows)::int rows from import_task_batches where completed_at>now()-interval '5 minutes' group by 1 order by 1`,
    sql`select percentile_cont(array[.5,.95,.99]) within group(order by parse_duration_ms) parse,percentile_cont(array[.5,.95,.99]) within group(order by rule_duration_ms) rule from import_tasks where created_at>now()-interval '24 hours' and parse_status='completed'`,
    sql`select percentile_cont(array[.5,.95,.99]) within group(order by validate_duration_ms) validate,percentile_cont(array[.5,.95,.99]) within group(order by insert_duration_ms) insert,percentile_cont(array[.5,.95,.99]) within group(order by total_duration_ms) total from batch_performance_log where created_at>now()-interval '24 hours'`,
    sql`select error_code,count(*)::int count from import_task_errors where created_at>now()-interval '24 hours' group by error_code order by count desc`,
    sql`select task_id,unit_id,batch_index,total_duration_ms from batch_performance_log order by total_duration_ms desc limit 10`,
    sql`select date_trunc('minute',completed_at) as time_bucket,count(*)::int count from import_tasks where status='failed' and completed_at>now()-interval '24 hours' group by 1 order by 1`,
    sql`select count(*)::int count from event_outbox where status='failed' and retry_count>=5`,
    sql`select count(*)::int count from event_outbox where status='failed' and created_at>now()-interval '15 minutes'`,
  ]);
  const totalErrors = errors.reduce((sum, row) => sum + Number(row.count), 0);
  const percentile = (value: unknown, index: number) => Array.isArray(value) ? Number(value[index] ?? 0) : 0;
  const durations = {} as MonitorSummary["durationPercentiles"];
  for (const key of ["parse", "rule"] as const) durations[key] = { p50: percentile(taskPerf[0]?.[key], 0), p95: percentile(taskPerf[0]?.[key], 1), p99: percentile(taskPerf[0]?.[key], 2) };
  for (const key of ["validate", "insert", "total"] as const) durations[key] = { p50: percentile(batchPerf[0]?.[key], 0), p95: percentile(batchPerf[0]?.[key], 1), p99: percentile(batchPerf[0]?.[key], 2) };
  const pendingRows = Number(queue[0]?.rows ?? 0);
  const recentQueueFailureCount = Number(recentQueueFailures[0]?.count ?? 0);
  const queueAvailable = Boolean(process.env.QSTASH_TOKEN) && recentQueueFailureCount === 0;
  const failedTaskCount = failed.reduce((sum, row) => sum + Number(row.count), 0);
  const deadLetterCount = Number(deadLetters[0]?.count ?? 0);
  const slowBatchCount = slow.filter((row) => Number(row.total_duration_ms) >= 10_000).length;
  const alerts: MonitorSummary["alerts"] = [];
  if (!process.env.QSTASH_TOKEN) alerts.push({ type: "queue", severity: "critical", message: "QStash 队列未配置", count: 1 });
  else if (recentQueueFailureCount) alerts.push({ type: "queue", severity: "critical", message: "QStash 最近投递失败，请检查 Token 与网络", count: recentQueueFailureCount });
  else if (pendingRows > 5_000) alerts.push({ type: "queue", severity: "warning", message: "待处理行数超过 5,000", count: pendingRows });
  if (deadLetterCount) alerts.push({ type: "dead_letter", severity: "critical", message: "Outbox 事件重试耗尽", count: deadLetterCount });
  if (failedTaskCount) alerts.push({ type: "failed_task", severity: "critical", message: "过去 24 小时存在失败任务", count: failedTaskCount });
  if (slowBatchCount) alerts.push({ type: "slow_batch", severity: "warning", message: "存在耗时超过 10 秒的批次", count: slowBatchCount });
  return { generatedAt: new Date().toISOString(), queue: { pendingBatches: Number(queue[0]?.batches ?? 0), pendingRows, available: queueAvailable, alert: !queueAvailable ? "critical" : pendingRows > 5_000 ? "warning" : "normal" }, throughput: throughput.map((row) => ({ minute: new Date(String(row.time_bucket)).toISOString(), rows: Number(row.rows) })), durationPercentiles: durations, errors: errors.map((row) => ({ code: String(row.error_code), count: Number(row.count), percentage: totalErrors ? Number(row.count) / totalErrors * 100 : 0 })), slowBatches: slow.map((row) => ({ taskId: String(row.task_id), unitId: String(row.unit_id), batchIndex: Number(row.batch_index), totalDurationMs: Number(row.total_duration_ms) })), failedTaskTrend: failed.map((row) => ({ minute: new Date(String(row.time_bucket)).toISOString(), count: Number(row.count) })), alerts };
}

export async function recoverStaleBatches() {
  await ensureAsyncImportSchema();
  const sql = db();
  const [parseTasks, batches] = await Promise.all([
    sql`select id,trace_id,parse_retry_count from import_tasks where parse_status='processing' and parse_locked_at<now()-interval '5 minutes' and status not in('completed','partial_success','failed')`,
    sql`select b.task_id,b.unit_id,b.batch_index,b.start_row,b.end_row,b.retry_count,t.trace_id from import_task_batches b join import_tasks t on t.id=b.task_id where b.status='processing' and b.locked_at<now()-interval '5 minutes'`,
  ]);
  const statements: ReturnType<Sql>[] = [];
  let terminalParses = 0;
  for (const task of parseTasks) {
    const terminal = Number(task.parse_retry_count) >= 3;
    if (terminal) {
      terminalParses += 1;
      statements.push(sql`update import_tasks set parse_status='failed',status='failed',recent_error='解析 Worker 心跳超时且重试已耗尽',completed_at=now(),last_heartbeat_at=now() where id=${task.id} and parse_status='processing'`);
      statements.push(sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${task.trace_id},${task.id},'ImportFileParseRecoveryFailed','error','解析 Worker 心跳超时且重试已耗尽',${JSON.stringify({ retryCount: Number(task.parse_retry_count) })}::jsonb)`);
      continue;
    }
    const event: ImportParseEventEnvelope = lifecycleEvent({ eventType: "ImportTaskCreated", taskId: String(task.id), traceId: String(task.trace_id), payload: { task_id: String(task.id) } });
    statements.push(sql`update import_tasks set parse_status='failed',status='pending',recent_error='解析 Worker 心跳超时，已重新投递',last_heartbeat_at=now() where id=${task.id} and parse_status='processing'`);
    statements.push(sql`insert into event_outbox(id,aggregate_id,event_type,payload) values(${event.event_id},${task.id},${event.event_type},${JSON.stringify(event)}::jsonb)`);
    statements.push(sql`insert into trace_events(id,trace_id,task_id,event_name,event_status,message,metadata) values(${makeId("trace")},${task.trace_id},${task.id},'ImportFileParseRecovered','warning','解析 Worker 心跳超时，已重新投递','{}'::jsonb)`);
  }
  let terminalBatches = 0;
  for (const batch of batches) {
    const terminal = Number(batch.retry_count) >= 3;
    statements.push(sql`update import_task_batches set status='failed',last_error=${terminal ? "Worker 心跳超时且重试已耗尽" : "Worker 心跳超时，已重新投递"},completed_at=${terminal ? new Date().toISOString() : null} where task_id=${batch.task_id} and unit_id=${batch.unit_id} and status='processing'`);
    if (terminal) {
      terminalBatches += 1;
      statements.push(sql`update import_tasks set status='failed',recent_error='处理单元心跳超时且重试已耗尽',completed_at=now(),last_heartbeat_at=now() where id=${batch.task_id}`);
      statements.push(sql`insert into trace_events(id,trace_id,task_id,unit_id,event_name,event_status,message,metadata) values(${makeId("trace")},${batch.trace_id},${batch.task_id},${batch.unit_id},'ImportBatchRecoveryFailed','error','处理单元心跳超时且重试已耗尽',${JSON.stringify({ retryCount: Number(batch.retry_count) })}::jsonb)`);
      continue;
    }
    const event: ImportBatchCreatedEvent = lifecycleEvent({
      eventType: "ImportBatchCreated",
      taskId: String(batch.task_id),
      traceId: String(batch.trace_id),
      payload: {
        task_id: String(batch.task_id),
        unit_id: String(batch.unit_id),
        batch_index: Number(batch.batch_index),
        start_row: Number(batch.start_row),
        end_row: Number(batch.end_row),
      },
    });
    statements.push(sql`insert into event_outbox(id,aggregate_id,event_type,payload) values(${event.event_id},${batch.task_id},${event.event_type},${JSON.stringify(event)}::jsonb)`);
    statements.push(sql`insert into trace_events(id,trace_id,task_id,unit_id,event_name,event_status,message,metadata) values(${makeId("trace")},${batch.trace_id},${batch.task_id},${batch.unit_id},'ImportBatchRecovered','warning','处理单元心跳超时，已重新投递',${JSON.stringify({ retryCount: Number(batch.retry_count) })}::jsonb)`);
  }
  if (statements.length) await sql.transaction(() => statements);
  return { recovered: parseTasks.length + batches.length, parseRecovered: parseTasks.length - terminalParses, batchRecovered: batches.length - terminalBatches, terminalParses, terminalBatches };
}

function mapTask(row: Record<string, unknown>): ImportTask { const elapsed = row.started_at ? (Date.now() - new Date(String(row.started_at)).getTime()) / 60_000 : 0; const throughput = elapsed > 0 ? Number(row.success_rows) / elapsed : 0; const remaining = Math.max(0, Number(row.total_rows) - Number(row.processed_rows)); return { id: String(row.id), fileName: String(row.file_name), fileHash: String(row.file_hash), ruleId: String(row.rule_id), status: String(row.status) as ImportTask["status"], totalRows: Number(row.total_rows), processedRows: Number(row.processed_rows), successRows: Number(row.success_rows), failedRows: Number(row.failed_rows), totalBatches: Number(row.total_batches), completedBatches: Number(row.completed_batches), traceId: String(row.trace_id), degraded: Boolean(row.degraded), degradedReason: row.degraded_reason ? String(row.degraded_reason) : null, createdAt: new Date(String(row.created_at)).toISOString(), startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null, completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null, lastHeartbeatAt: row.last_heartbeat_at ? new Date(String(row.last_heartbeat_at)).toISOString() : null, recentError: row.recent_error ? String(row.recent_error) : null, throughputPerMinute: Math.round(throughput), estimatedSecondsRemaining: throughput > 0 ? Math.ceil(remaining / throughput * 60) : null }; }
function mapBatch(row: Record<string, unknown>): ImportTaskBatch { return { id: String(row.id), taskId: String(row.task_id), unitId: String(row.unit_id), batchIndex: Number(row.batch_index), startRow: Number(row.start_row), endRow: Number(row.end_row), status: String(row.status) as ImportTaskBatch["status"], retryCount: Number(row.retry_count), successRows: Number(row.success_rows), failedRows: Number(row.failed_rows), lockedAt: row.locked_at ? new Date(String(row.locked_at)).toISOString() : null, completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null, lastError: row.last_error ? String(row.last_error) : null }; }
function mapError(row: Record<string, unknown>): ImportTaskError { return { id: String(row.id), taskId: String(row.task_id), unitId: String(row.unit_id), batchIndex: Number(row.batch_index), rowNumber: Number(row.row_number), fieldName: String(row.field_name), rawValue: String(row.raw_value), errorCode: String(row.error_code) as ImportErrorCode, errorReason: String(row.error_reason), suggestion: String(row.suggestion), ruleId: String(row.rule_id), traceId: String(row.trace_id), createdAt: new Date(String(row.created_at)).toISOString() }; }
function mapPerformance(row: Record<string, unknown>): BatchPerformance { return { unitId: String(row.unit_id), batchIndex: Number(row.batch_index), parseDurationMs: Number(row.parse_duration_ms), ruleDurationMs: Number(row.rule_duration_ms), validateDurationMs: Number(row.validate_duration_ms), insertDurationMs: Number(row.insert_duration_ms), totalDurationMs: Number(row.total_duration_ms), status: String(row.status) as BatchPerformance["status"], retryCount: Number(row.retry_count) }; }
function mapTrace(row: Record<string, unknown>): TraceEvent { return { id: String(row.id), traceId: String(row.trace_id), taskId: String(row.task_id), unitId: row.unit_id ? String(row.unit_id) : null, eventName: String(row.event_name), eventStatus: String(row.event_status) as TraceEvent["eventStatus"], message: String(row.message), metadata: row.metadata as Record<string, unknown>, occurredAt: new Date(String(row.occurred_at)).toISOString() }; }

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { MIMO_MODEL, MIMO_PROVIDER_LABEL } from "@/lib/constants";
import { demoRules } from "@/lib/demo-rules";
import type {
  DashboardSnapshot,
  DocumentRule,
  ExistingExternalCodeRef,
  ImportBatchSummary,
  ShipmentOrder,
  ShipmentRow,
  ShipmentSearchParams,
  ShipmentSearchResult,
} from "@/lib/types";
import { makeId } from "@/lib/utils";
import { groupShipmentRows } from "@/lib/validation";

let schemaReady = false;
let schemaReadyPromise: Promise<void> | null = null;
type SqlClient = NeonQueryFunction<false, false>;

let cachedSqlClient: SqlClient | null | undefined;
let builtInRulesSynced = false;

export class DuplicateExternalCodeError extends Error {
  readonly externalCodes: string[];

  constructor(externalCodes: string[]) {
    super(`外部编码已存在：${externalCodes.join("、")}`);
    this.name = "DuplicateExternalCodeError";
    this.externalCodes = externalCodes;
  }
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("缺少 DATABASE_URL 或 POSTGRES_URL，规则和运单必须持久化到 Neon/Postgres。");
    this.name = "DatabaseNotConfiguredError";
  }
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
}

function getSqlClient(): SqlClient | null {
  if (cachedSqlClient !== undefined) {
    return cachedSqlClient;
  }

  const url = getDatabaseUrl();
  if (!url) {
    cachedSqlClient = null;
    return null;
  }

  cachedSqlClient = neon(url);
  return cachedSqlClient;
}

function getRequiredSqlClient(): SqlClient {
  const sql = getSqlClient();
  if (!sql) {
    throw new DatabaseNotConfiguredError();
  }
  return sql;
}

async function ensureStoreSeeded() {
  const sql = getRequiredSqlClient();
  await ensurePgSchema(sql);
  if (!builtInRulesSynced) {
    for (const rule of demoRules) {
      await upsertRulePg(sql, rule);
    }
    builtInRulesSynced = true;
  }
}

export async function listRules() {
  await ensureStoreSeeded();
  const sql = getRequiredSqlClient();
  const rows = await sql`
    select definition
    from parse_rules
    order by is_template asc, updated_at desc
  `;

  return rows
    .map((item) => normalizeRuleRecord(item.definition))
    .filter(Boolean) as DocumentRule[];
}

export async function getRule(ruleId: string) {
  const rules = await listRules();
  return rules.find((rule) => rule.id === ruleId) ?? null;
}

export async function saveRule(rule: DocumentRule) {
  await ensureStoreSeeded();
  const nextRule = {
    ...rule,
    updatedAt: new Date().toISOString(),
  };
  const sql = getRequiredSqlClient();
  await upsertRulePg(sql, nextRule);
  return nextRule;
}

export async function deleteRule(ruleId: string) {
  const sql = getRequiredSqlClient();
  await ensurePgSchema(sql);
  await sql`delete from parse_rules where id = ${ruleId}`;
}

export async function listExistingExternalCodes() {
  const refs = await listExistingExternalCodeRefs();
  return refs.map((item) => item.externalCode);
}

export async function listExistingExternalCodeRefs(): Promise<ExistingExternalCodeRef[]> {
  const sql = getRequiredSqlClient();
  await ensurePgSchema(sql);
  const rows = await sql`
    select external_code, id, batch_id, created_at
    from shipment_orders
    where external_code is not null and external_code <> ''
    order by created_at desc
  `;

  return rows.map((item) => ({
    externalCode: String(item.external_code),
    orderId: String(item.id),
    batchId: String(item.batch_id),
    createdAt: new Date(String(item.created_at)).toISOString(),
  }));
}
export async function submitShipmentBatch(input: {
  fileName: string;
  ruleId: string;
  rows: ShipmentRow[];
}) {
  const batch: ImportBatchSummary = {
    id: makeId("batch"),
    fileName: input.fileName,
    ruleId: input.ruleId,
    rowCount: input.rows.length,
    successCount: input.rows.length,
    failedCount: 0,
    createdAt: new Date().toISOString(),
  };

  const rows = input.rows.map((row) => ({
    ...row,
    batchId: batch.id,
    createdAt: batch.createdAt,
  }));
  const orders = buildShipmentOrders(rows, batch.createdAt);

  const sql = getRequiredSqlClient();
  await ensurePgSchema(sql);
  const conflicts = await findConflictingExternalCodes(orders.map((order) => order.externalCode));
  if (conflicts.length) {
    throw new DuplicateExternalCodeError(conflicts);
  }

  try {
    await sql.transaction((txn) => [
      txn`
        insert into import_batches (id, file_name, rule_id, row_count, success_count, failed_count, created_at)
        values (${batch.id}, ${batch.fileName}, ${batch.ruleId}, ${batch.rowCount}, ${batch.successCount}, ${batch.failedCount}, ${batch.createdAt}::timestamptz)
      `,
      ...orders.map((order) => txn`
        insert into shipment_orders (
          id, batch_id, external_code, store_name, recipient_name, recipient_phone,
          recipient_address, sku_count, total_qty, row_ids, created_at, payload
        ) values (
          ${order.id},
          ${batch.id},
          ${order.externalCode.trim() || null},
          ${order.storeName},
          ${order.recipientName},
          ${order.recipientPhone},
          ${order.recipientAddress},
          ${order.skuCount},
          ${String(order.totalQty)},
          ${JSON.stringify(order.rowIds)}::jsonb,
          ${batch.createdAt}::timestamptz,
          ${JSON.stringify(order)}::jsonb
        )
      `),
      ...rows.map((row) => txn`
        insert into shipment_rows (
          id, batch_id, source_file_name, external_code, store_name, recipient_name, recipient_phone,
          recipient_address, sku_code, sku_name, sku_qty, sku_spec, temperature_zone, remark, created_at, payload
        ) values (
          ${row.id},
          ${batch.id},
          ${row.sourceFileName ?? batch.fileName},
          ${row.externalCode.trim() || null},
          ${row.storeName},
          ${row.recipientName},
          ${row.recipientPhone},
          ${row.recipientAddress},
          ${row.skuCode},
          ${row.skuName},
          ${row.skuQty || "0"},
          ${row.skuSpec},
          ${row.temperatureZone},
          ${row.remark},
          ${row.createdAt}::timestamptz,
          ${JSON.stringify(row)}::jsonb
        )
      `),
    ]);
  } catch (error) {
    const nextConflicts = await findConflictingExternalCodes(orders.map((order) => order.externalCode));
    if (nextConflicts.length) {
      throw new DuplicateExternalCodeError(nextConflicts);
    }
    throw error;
  }

  return batch;
}

export async function listShipmentRows(params: ShipmentSearchParams = {}): Promise<ShipmentSearchResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(10, Math.min(100, params.pageSize ?? 20));
  const sql = getRequiredSqlClient();

  let rows: ShipmentRow[] = [];
  let batches: ImportBatchSummary[] = [];

  await ensurePgSchema(sql);
  const shipmentRows = await sql`
    select payload
    from shipment_rows
    order by created_at desc
    limit 5000
  `;
  rows = shipmentRows.map((item) => normalizeShipmentRecord(item.payload)).filter(Boolean) as ShipmentRow[];

  const batchRows = await sql`
    select id, file_name, rule_id, row_count, success_count, failed_count, created_at
    from import_batches
    order by created_at desc
    limit 100
  `;
  batches = batchRows.map((item) => ({
    id: String(item.id),
    fileName: String(item.file_name),
    ruleId: String(item.rule_id),
    rowCount: Number(item.row_count),
    successCount: Number(item.success_count),
    failedCount: Number(item.failed_count),
    createdAt: new Date(String(item.created_at)).toISOString(),
  }));

  const filtered = rows.filter((row) => matchShipmentRow(row, params));
  const orders = groupShipmentRows(filtered);
  const start = (page - 1) * pageSize;
  const paged = filtered.slice(start, start + pageSize);
  const pagedOrders = orders.slice(start, start + pageSize);

  return {
    rows: paged,
    orders: pagedOrders,
    total: filtered.length,
    totalOrders: orders.length,
    page,
    pageSize,
    batches,
  };
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const rules = await listRules();
  const shipments = await listShipmentRows({ page: 1, pageSize: 5000 });
  const duplicateMap = new Map<string, number>();

  shipments.rows.forEach((row) => {
    if (!row.externalCode.trim()) {
      return;
    }
    duplicateMap.set(row.externalCode, (duplicateMap.get(row.externalCode) ?? 0) + 1);
  });

  const duplicateExternalCodeCount = Array.from(duplicateMap.values()).filter((count) => count > 1).length;
  const lastImportedAt = shipments.batches[0]?.createdAt ?? null;

  return {
    ruleCount: rules.filter((rule) => !rule.isTemplate).length,
    templateCount: rules.filter((rule) => rule.isTemplate).length,
    shipmentRowCount: shipments.total,
    batchCount: shipments.batches.length,
    duplicateExternalCodeCount,
    strategyCount: new Set(rules.map((rule) => rule.extractor.kind)).size,
    providerLabel: `${MIMO_PROVIDER_LABEL} / ${process.env.MIMO_MODEL ?? MIMO_MODEL}`,
    lastImportedAt,
  };
}

async function findConflictingExternalCodes(codes: string[]) {
  const normalizedCodes = codes.map((code) => code.trim()).filter(Boolean);
  if (!normalizedCodes.length) {
    return [];
  }

  const existing = new Set(await listExistingExternalCodes());
  return Array.from(new Set(normalizedCodes.filter((code) => existing.has(code))));
}

function buildShipmentOrders(rows: ShipmentRow[], createdAt: string): ShipmentOrder[] {
  const grouped = new Map<string, ShipmentRow[]>();

  rows.forEach((row) => {
    const externalCode = row.externalCode.trim() || `__blank__${row.id}`;
    grouped.set(externalCode, [...(grouped.get(externalCode) ?? []), row]);
  });

  return Array.from(grouped.entries()).map(([externalCode, items]) => {
    const first = items[0];
    return {
      id: makeId("order"),
      externalCode: externalCode.startsWith("__blank__") ? "" : externalCode,
      storeName: first.storeName,
      recipientName: first.recipientName,
      recipientPhone: first.recipientPhone,
      recipientAddress: first.recipientAddress,
      skuCount: items.length,
      totalQty: items.reduce((sum, row) => {
        const qty = Number(row.skuQty);
        return Number.isFinite(qty) ? sum + qty : sum;
      }, 0),
      rowIds: items.map((row) => row.id),
      createdAt,
    };
  });
}

async function ensurePgSchema(sql: SqlClient) {
  if (schemaReady) {
    return;
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await sql`
        create table if not exists parse_rules (
          id text primary key,
          name text not null,
          source_type text not null,
          definition jsonb not null,
          is_template boolean not null default false,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists import_batches (
          id text primary key,
          file_name text not null,
          rule_id text not null,
          row_count integer not null,
          success_count integer not null,
          failed_count integer not null,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists shipment_orders (
          id text primary key,
          batch_id text not null,
          external_code text,
          store_name text,
          recipient_name text,
          recipient_phone text,
          recipient_address text,
          sku_count integer not null,
          total_qty numeric not null,
          row_ids jsonb not null,
          created_at timestamptz not null default now(),
          payload jsonb not null
        )
      `;
      await sql`alter table shipment_orders alter column external_code drop not null`;
      await sql`alter table shipment_orders drop constraint if exists shipment_orders_external_code_key`;
      await sql`
        create table if not exists shipment_rows (
          id text primary key,
          batch_id text not null,
          source_file_name text,
          external_code text,
          store_name text,
          recipient_name text,
          recipient_phone text,
          recipient_address text,
          sku_code text not null,
          sku_name text not null,
          sku_qty numeric not null,
          sku_spec text,
          temperature_zone text,
          remark text,
          created_at timestamptz not null default now(),
          payload jsonb not null
        )
      `;
      await sql`create index if not exists shipment_rows_external_code_idx on shipment_rows (external_code)`;
      await sql`create index if not exists shipment_rows_created_at_idx on shipment_rows (created_at desc)`;
      await sql`create index if not exists shipment_orders_created_at_idx on shipment_orders (created_at desc)`;
      await sql`
        create unique index if not exists shipment_orders_external_code_unique_idx
        on shipment_orders (external_code)
        where external_code is not null and external_code <> ''
      `;

      schemaReady = true;
    })().finally(() => {
      if (!schemaReady) {
        schemaReadyPromise = null;
      }
    });
  }

  await schemaReadyPromise;
}

export async function ensureV2Schema() {
  const sql = getRequiredSqlClient();
  await ensurePgSchema(sql);
}

async function upsertRulePg(sql: SqlClient, rule: DocumentRule) {
  await ensurePgSchema(sql);
  await sql`
    insert into parse_rules (id, name, source_type, definition, is_template, created_at, updated_at)
    values (
      ${rule.id},
      ${rule.name},
      ${rule.sourceType},
      ${JSON.stringify(rule)}::jsonb,
      ${Boolean(rule.isTemplate)},
      ${rule.createdAt}::timestamptz,
      ${rule.updatedAt}::timestamptz
    )
    on conflict (id) do update set
      name = excluded.name,
      source_type = excluded.source_type,
      definition = excluded.definition,
      is_template = excluded.is_template,
      updated_at = excluded.updated_at
  `;
}

function normalizeRuleRecord(value: unknown) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as DocumentRule;
  }
  return value as DocumentRule;
}

function normalizeShipmentRecord(value: unknown) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as ShipmentRow;
  }
  return value as ShipmentRow;
}

function matchShipmentRow(row: ShipmentRow, params: ShipmentSearchParams) {
  const query = params.query?.trim().toLowerCase();
  const recipient = params.recipient?.trim().toLowerCase();
  const dateFrom = params.dateFrom ? new Date(params.dateFrom).getTime() : null;
  const dateTo = params.dateTo ? new Date(params.dateTo).getTime() : null;
  const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : null;

  if (query) {
    const haystack = [
      row.externalCode,
      row.skuCode,
      row.skuName,
      row.storeName,
      row.recipientName,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }

  if (recipient && !row.recipientName.toLowerCase().includes(recipient)) {
    return false;
  }

  if (dateFrom && createdAt && createdAt < dateFrom) {
    return false;
  }

  if (dateTo && createdAt && createdAt > dateTo + 24 * 60 * 60 * 1000) {
    return false;
  }

  return true;
}

create table if not exists parse_rules (
  id text primary key,
  name text not null,
  source_type text not null,
  definition jsonb not null,
  is_template boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists import_batches (
  id text primary key,
  file_name text not null,
  rule_id text not null,
  row_count integer not null,
  success_count integer not null,
  failed_count integer not null,
  created_at timestamptz not null default now()
);

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
);

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
);

alter table shipment_orders alter column external_code drop not null;
alter table shipment_orders drop constraint if exists shipment_orders_external_code_key;

create index if not exists shipment_rows_external_code_idx on shipment_rows (external_code);
create index if not exists shipment_rows_created_at_idx on shipment_rows (created_at desc);
create index if not exists shipment_orders_created_at_idx on shipment_orders (created_at desc);
create unique index if not exists shipment_orders_external_code_unique_idx
  on shipment_orders (external_code)
  where external_code is not null and external_code <> '';

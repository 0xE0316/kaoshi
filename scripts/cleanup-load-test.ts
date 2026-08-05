import { neon } from "@neondatabase/serverless";
async function main() {
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl) throw new Error("请设置 DATABASE_URL");
const sql = neon(databaseUrl);
const tasks = await sql`select id from import_tasks where file_name='10000-orders.xlsx'`;
const taskIds = tasks.map((row) => String(row.id));
await sql.transaction((tx) => [
  tx`delete from shipment_rows where batch_id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from shipment_orders where batch_id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from import_batches where id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from batch_performance_log where task_id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from trace_events where task_id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from event_outbox where aggregate_id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from import_tasks where id in(select jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb))`,
  tx`delete from sku_master where id like 'load-sku-%'`,
  tx`delete from event_outbox where created_at<now()-interval '7 days' and status='sent'`,
  tx`delete from trace_events where occurred_at<now()-interval '30 days'`,
  tx`delete from batch_performance_log where created_at<now()-interval '30 days'`,
]);
console.log(`已清理 ${taskIds.length} 个压测任务、关联运单、压测 SKU 及过期观测数据。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

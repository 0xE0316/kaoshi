import fs from "node:fs";

import { neon } from "@neondatabase/serverless";
import * as XLSX from "xlsx";

async function main() {
const skuCount = 20_000;
const rowCount = 10_000;
const skuRecords = Array.from({ length: skuCount }, (_, index) => {
  const no = String(index + 1).padStart(5, "0");
  return { id: `load-sku-${no}`, sku_code: `SKU_${no}`, name: `压测商品 ${no}`, spec: `${(index % 12) + 1}kg/件`, unit: "件" };
});
const rows = Array.from({ length: rowCount }, (_, index) => {
  const skuNo = (index * 7919) % skuCount + 1;
  const invalid = index > 0 && index % 997 === 0;
  return {
    外部编码: `LOAD_${String(index + 1).padStart(6, "0")}`,
    收货门店: `压测门店 ${(index % 200) + 1}`,
    收件人姓名: "",
    收件人电话: "",
    收件人地址: "",
    SKU物品编码: invalid ? `INVALID_${index}` : `SKU_${String(skuNo).padStart(5, "0")}`,
    SKU物品名称: `压测商品 ${String(skuNo).padStart(5, "0")}`,
    SKU发货数量: (index % 5) + 1,
    SKU规格型号: `${(skuNo % 12) + 1}kg/件`,
    温层: ["常温", "冷藏", "冷冻"][index % 3],
    备注: invalid ? "故意注入非法 SKU" : "大促压测",
  };
});

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "10000-orders");
fs.mkdirSync("test-data", { recursive: true });
XLSX.writeFile(workbook, "test-data/10000-orders.xlsx");

if (process.env.LOAD_TEST_FILE_ONLY !== "true") {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!databaseUrl) throw new Error("请设置 DATABASE_URL");
  const sql = neon(databaseUrl);
  await sql`create table if not exists sku_master(id text primary key,sku_code text unique not null,name text not null,spec text not null,unit text not null,created_at timestamptz not null default now())`;
  const chunkSize = 2_000;
  for (let start = 0; start < skuRecords.length; start += chunkSize) {
    const chunk = skuRecords.slice(start, start + chunkSize);
    await sql`insert into sku_master(id,sku_code,name,spec,unit) select x.id,x.sku_code,x.name,x.spec,x.unit from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as x(id text,sku_code text,name text,spec text,unit text) on conflict(sku_code) do update set name=excluded.name,spec=excluded.spec,unit=excluded.unit`;
  }
}

console.log(JSON.stringify({ skuMaster: process.env.LOAD_TEST_FILE_ONLY === "true" ? "skipped" : skuCount, excelRows: rowCount, file: "test-data/10000-orders.xlsx" }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

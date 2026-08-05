import { ensureAsyncImportSchema } from "../src/lib/server/async-import-storage";

async function main() {
  await ensureAsyncImportSchema({ force: true });
  console.log("V2 与 V4 PostgreSQL Schema 迁移完成");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

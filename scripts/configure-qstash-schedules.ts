import { Client } from "@upstash/qstash";

const definitions = [
  { label: "kaoshi-import-dispatcher", path: "/api/import-dispatcher", cron: "* * * * *" },
  { label: "kaoshi-import-recovery", path: "/api/import-cron/recover", cron: "*/5 * * * *" },
] as const;

async function main() {
  const token = required("QSTASH_TOKEN");
  const cronSecret = required("CRON_SECRET");
  const baseUrl = normalizeBaseUrl(required("QSTASH_SCHEDULE_BASE_URL"));
  const client = new Client({ token });
  const existing = await client.schedules.list();
  const configured: Array<{ label: string; scheduleId: string; destination: string; cron: string }> = [];

  for (const definition of definitions) {
    const stale = existing.filter((schedule) => schedule.labels?.includes(definition.label) || schedule.label === definition.label);
    await Promise.all(stale.map((schedule) => client.schedules.delete(schedule.scheduleId)));
    const destination = `${baseUrl}${definition.path}`;
    const created = await client.schedules.create({
      destination,
      cron: definition.cron,
      method: "GET",
      retries: 3,
      headers: { authorization: `Bearer ${cronSecret}` },
      label: ["kaoshi-v4", definition.label],
      redact: { header: ["authorization"] },
    });
    configured.push({ ...definition, destination, scheduleId: created.scheduleId });
  }

  console.log(JSON.stringify({ configured }, null, 2));
}

function required(name: "QSTASH_TOKEN" | "CRON_SECRET" | "QSTASH_SCHEDULE_BASE_URL") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("QSTASH_SCHEDULE_BASE_URL 必须使用 HTTPS");
  return url.origin;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

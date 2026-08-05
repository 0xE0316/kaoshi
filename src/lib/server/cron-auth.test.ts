import { afterEach, describe, expect, it } from "vitest";

import { rejectUnauthorizedCron } from "@/lib/server/cron-auth";

const originalSecret = process.env.CRON_SECRET;
const originalNodeEnv = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;

afterEach(() => {
  if (originalSecret === undefined) delete mutableEnv.CRON_SECRET;
  else mutableEnv.CRON_SECRET = originalSecret;
  if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = originalNodeEnv;
});

describe("cron authentication", () => {
  it("fails closed in production when CRON_SECRET is missing", () => {
    delete process.env.CRON_SECRET;
    mutableEnv.NODE_ENV = "production";
    expect(rejectUnauthorizedCron(new Request("http://localhost/cron"))?.status).toBe(503);
  });

  it("accepts only the configured bearer token", () => {
    process.env.CRON_SECRET = "test-secret";
    expect(rejectUnauthorizedCron(new Request("http://localhost/cron"))?.status).toBe(401);
    expect(rejectUnauthorizedCron(new Request("http://localhost/cron", { headers: { authorization: "Bearer test-secret" } }))).toBeNull();
  });
});

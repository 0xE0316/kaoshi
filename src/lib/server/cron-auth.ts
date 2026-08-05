export function rejectUnauthorizedCron(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV === "production"
      ? Response.json({ error: "CRON_SECRET 未配置" }, { status: 503 })
      : null;
  }
  return request.headers.get("authorization") === `Bearer ${secret}`
    ? null
    : Response.json({ error: "Unauthorized" }, { status: 401 });
}

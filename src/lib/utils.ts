export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function extractFirstJsonObject(input: string) {
  const fenced = input.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return input.slice(firstBrace, lastBrace + 1);
  }

  return input.trim();
}

export function coerceString(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function formatDateTime(input?: string | null) {
  if (!input) {
    return "--";
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const SHANGHAI_TZ = "Asia/Shanghai";

export function startOfShanghaiDay(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return new Date(`${year}-${month}-${day}T00:00:00+08:00`);
}

export function compactId(value: string, keep = 10): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export function previewText(value: string | null | undefined, limit = 120): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!compact) return "—";
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function jsonPreview(value: unknown, limit = 180): string {
  if (value === null || value === undefined) return "—";
  const text = JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getStringPath(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    current = asRecord(current)[segment];
  }
  return typeof current === "string" && current ? current : null;
}

export function percentLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

const PRIORITY_KEYS = [
  "description",
  "summary",
  "caption",
  "transcription",
  "transcript",
  "ocrText",
  "text",
  "content",
  "scene",
] as const;

const NOISE_KEYS = new Set([
  "id",
  "type",
  "mimeType",
  "contentType",
  "fileName",
  "fileSize",
  "width",
  "height",
  "duration",
  "confidence",
  "score",
  "source",
  "model",
  "usage",
  "tokens",
  "metadata",
]);

function getString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return trimmed ? trimmed : null;
}

function normalizeValue(value: unknown): unknown {
  const directString = getString(value);
  if (!directString) return value;

  const looksLikeJson =
    (directString.startsWith("{") && directString.endsWith("}")) ||
    (directString.startsWith("[") && directString.endsWith("]"));

  if (!looksLikeJson) return directString;

  try {
    return JSON.parse(directString);
  } catch {
    return directString;
  }
}

export function formatMediaDescriptionRaw(value: unknown): string {
  const normalized = normalizeValue(value);
  const text = getString(normalized);

  if (text) return text;

  if (normalized === null || normalized === undefined) return "";

  try {
    return JSON.stringify(normalized, null, 2);
  } catch {
    return String(normalized);
  }
}

function isMediaDescription(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTexts(value: unknown, parts: string[], seen: Set<string>) {
  const normalized = normalizeValue(value);
  const text = getString(normalized);

  if (text) {
    if (!seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
    return;
  }

  if (Array.isArray(normalized)) {
    for (const item of normalized) {
      collectTexts(item, parts, seen);
    }
    return;
  }

  if (!isMediaDescription(normalized)) return;

  for (const key of PRIORITY_KEYS) {
    if (key in normalized) {
      collectTexts(normalized[key], parts, seen);
    }
  }

  for (const [key, item] of Object.entries(normalized)) {
    if (PRIORITY_KEYS.includes(key as (typeof PRIORITY_KEYS)[number]) || NOISE_KEYS.has(key)) {
      continue;
    }

    collectTexts(item, parts, seen);
  }
}

function summarizeText(text: string, maxLength = 68): string {
  if (text.length <= maxLength && !text.includes("\n")) return text;

  const firstLine = text.split("\n")[0]?.trim() ?? text;
  if (firstLine.length <= maxLength) return `${firstLine}...`;

  return `${firstLine.slice(0, maxLength).trimEnd()}...`;
}

export interface MediaDescriptionContent {
  summary: string | null;
  details: string[];
  fullText: string | null;
}

export function getMediaDescriptionContent(value: unknown): MediaDescriptionContent {
  const parts: string[] = [];
  collectTexts(value, parts, new Set<string>());

  if (parts.length === 0) {
    return {
      summary: null,
      details: [],
      fullText: null,
    };
  }

  const [first, ...rest] = parts;
  const details = [...rest];
  const summary = summarizeText(first);

  if (summary !== first || first.includes("\n")) {
    details.unshift(first);
  }

  return {
    summary,
    details,
    fullText: parts.join("\n\n"),
  };
}

export function getMediaDescriptionText(value: unknown): string | null {
  return getMediaDescriptionContent(value).fullText;
}

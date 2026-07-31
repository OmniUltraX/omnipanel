/** 与后端 sanitize / redact 对齐的密钥打码，用于工具结果进 AI 前兜底。 */

const SECRET_KEY_RE =
  /^(?:.*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|passphrase|authorization|credential|auth[_-]?value).*)$/i;

const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
];

const REDACTED = "***";

function isSecretEnvKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    SECRET_KEY_RE.test(lower) ||
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.endsWith("_token") ||
    lower.endsWith("token") ||
    lower.includes("apikey") ||
    lower.includes("api_key")
  );
}

function redactValuePatterns(text: string): string {
  let out = text;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

function redactEnvLine(line: string): string {
  const m = ENV_LINE_RE.exec(line);
  if (!m) return redactValuePatterns(line);
  const [, key, value] = m;
  if (isSecretEnvKey(key) && value.length > 0) {
    return `${key}=${REDACTED}`;
  }
  return `${key}=${redactValuePatterns(value)}`;
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string" && ENV_LINE_RE.test(item)) {
        return redactEnvLine(item);
      }
      return redactJsonValue(item);
    });
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretEnvKey(k)) {
        out[k] = typeof v === "string" && v.length === 0 ? "" : REDACTED;
        continue;
      }
      if (k.toLowerCase() === "env" && Array.isArray(v)) {
        out[k] = v.map((item) =>
          typeof item === "string" ? redactEnvLine(item) : redactJsonValue(item),
        );
        continue;
      }
      out[k] = redactJsonValue(v);
    }
    return out;
  }
  if (typeof value === "string") {
    return redactValuePatterns(value);
  }
  return value;
}

/** 对工具结果文本做密钥打码（JSON 优先按结构处理，否则按行/模式）。 */
export function redactSecretsInText(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return input;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(redactJsonValue(parsed), null, 2);
  } catch {
    /* not JSON */
  }

  return input
    .split("\n")
    .map((line) => {
      if (ENV_LINE_RE.test(line.trim())) {
        return redactEnvLine(line.trim());
      }
      return redactValuePatterns(line);
    })
    .join("\n");
}

/** Docker inspect 等返回的 env 字符串数组打码。 */
export function redactEnvArray(env: string[] | undefined | null): string[] {
  if (!env) return [];
  return env.map((line) => redactEnvLine(line));
}

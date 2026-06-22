/** 从可能含多余内容的字符串中提取首个完整 JSON 值 */
function extractFirstJsonValue(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;

  const open = trimmed[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** 解析模型 tool call 参数，兼容流式拼接产生的重复 JSON 片段 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("tool 参数必须是 JSON 对象");
  } catch (error) {
    const first = extractFirstJsonValue(trimmed);
    if (first) {
      try {
        const parsed = JSON.parse(first) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* fall through */
      }
    }
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
}

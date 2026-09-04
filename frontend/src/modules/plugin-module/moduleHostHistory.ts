import type { CodeEditorLanguage } from "../../components/ui/content/CodeEditor";

export type HistoryDiffKind = "same" | "add" | "del";

export type HistoryDiffLine = {
  kind: HistoryDiffKind;
  text: string;
};

export function formatHistoryTime(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? String(raw) : date.toLocaleString();
  }
  const text = String(raw).trim();
  if (!text) return "";
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    const ms = text.length <= 10 ? n * 1000 : n;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toLocaleString();
  return text;
}

export function editorLanguageFromType(
  type: string | undefined,
  fallback: CodeEditorLanguage = "text",
): CodeEditorLanguage {
  const raw = (type ?? "").trim().toLowerCase();
  const token = raw.includes(".") ? (raw.split(".").pop() ?? raw) : raw;
  if (token === "json") return "json";
  if (token === "yaml" || token === "yml") return "yaml";
  if (token === "properties" || token === "ini" || token === "conf") return "ini";
  if (token === "xml" || token === "html" || token === "text" || token === "txt") return "text";
  if (token === "sql") return "sql";
  if (token === "sh" || token === "shell" || token === "bash") return "shell";
  return fallback;
}

export function historyItemId(item: Record<string, unknown>): string {
  return String(item.nid ?? item.id ?? item.lastModified ?? "");
}

/** 针对配置正文的行级 LCS diff；超长时退化为整段增删，避免 O(n²) 卡死。 */
export function diffTextLines(left: string, right: string): HistoryDiffLine[] {
  const a = left.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const b = right.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (a.length * b.length > 250_000) {
    if (left === right) return a.map((text) => ({ kind: "same" as const, text }));
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: HistoryDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j]! });
    j += 1;
  }
  return out;
}

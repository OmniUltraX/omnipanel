import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { DbColumnMeta } from "../api";
import { filterAndRankByFuzzy } from "../../../lib/fuzzyMatch";

export type TablePreviewQueryMode = "where" | "order";

const WHERE_KEYWORDS = [
  "AND",
  "OR",
  "NOT",
  "LIKE",
  "IN",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "BETWEEN",
  "EXISTS",
] as const;

const ORDER_KEYWORDS = ["ASC", "DESC"] as const;

function currentWord(context: CompletionContext): { from: number; to: number; text: string } | null {
  const match = context.matchBefore(/[A-Za-z0-9_`.$"[\]]*/);
  if (!match) {
    if (context.explicit) {
      return { from: context.pos, to: context.pos, text: "" };
    }
    return null;
  }
  if (match.from === match.to && !context.explicit) return null;
  return { from: match.from, to: match.to, text: match.text };
}

function columnCompletions(columns: DbColumnMeta[], prefix: string): Completion[] {
  const items = columns.map((col) => ({
    label: col.name,
    detail: col.type || undefined,
    boost: (col.isPk ? 20 : 0) + (col.isFk ? 10 : 0),
  }));
  const ranked = filterAndRankByFuzzy(items, prefix);
  return ranked.map((item) => ({
    label: item.label,
    type: "property",
    detail: item.detail,
    boost: 100 + (item.boost ?? 0),
  }));
}

function keywordCompletions(keywords: readonly string[], prefix: string): Completion[] {
  const items = keywords.map((label) => ({ label, boost: 0 }));
  const ranked = filterAndRankByFuzzy(items, prefix);
  return ranked.map((item) => ({
    label: item.label,
    type: "keyword",
    boost: 40,
  }));
}

/** 表数据 WHERE / ORDER BY 单行输入的字段 + 关键词补全。 */
export function createTablePreviewQueryCompletionSource(
  getColumns: () => DbColumnMeta[] | undefined,
  getMode: () => TablePreviewQueryMode,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const word = currentWord(context);
    if (!word) return null;
    const prefix = word.text.replace(/^[`"[.\]]+|[`"\]]+$/g, "");
    const columns = getColumns() ?? [];
    const mode = getMode();
    const options: Completion[] = [
      ...columnCompletions(columns, prefix),
      ...keywordCompletions(mode === "where" ? WHERE_KEYWORDS : ORDER_KEYWORDS, prefix),
    ];
    if (options.length === 0) return null;
    return {
      from: word.from,
      options,
      validFor: /^[A-Za-z0-9_`.$"[\]]*$/,
    };
  };
}

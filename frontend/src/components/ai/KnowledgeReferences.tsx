import { useState } from "react";
import { KnowledgeKindIcon } from "../ui/icons/KnowledgeKindIcon";
import { IconBook } from "../ui/icons/Icons";

/** Parsed knowledge search result item from the AI tool call result JSON. */
interface KnowledgeRefItem {
  id: string;
  title: string;
  kind: string;
  snippet: string;
  tags: string[];
  risk_level: string;
  env_tag: string;
}

/** Props: the raw JSON result string from a search_knowledge tool call. */
export function KnowledgeReferences({ result }: { result: string }) {
  const [expanded, setExpanded] = useState(false);

  let items: KnowledgeRefItem[] = [];
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      items = parsed;
    }
  } catch {
    // Not valid JSON or not an array — don't render
    return null;
  }

  if (items.length === 0) return null;

  const kindLabels: Record<string, string> = {
    snippet: "代码片段",
    case: "排障案例",
    ai: "AI 知识",
  };

  const riskColors: Record<string, string> = {
    safe: "text-success",
    readonly: "text-info",
    medium: "text-warning",
    dangerous: "text-danger",
  };

  const envColors: Record<string, string> = {
    dev: "bg-info/20 text-info",
    staging: "bg-warning/20 text-warning",
    production: "bg-danger/20 text-danger",
  };

  return (
    <div className="mt-2 border border-border rounded-md overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-fg-2 hover:bg-surface-hover transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <IconBook size={14} className="knowledge-kind-icon" />
        <span className="font-medium">知识库参考</span>
        <span className="text-meta">({items.length} 条结果)</span>
        <span className="text-muted ml-auto">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {items.map((item) => (
            <div key={item.id} className="px-3 py-2 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <KnowledgeKindIcon kind={item.kind} size={12} />
                <span className="font-medium text-fg">{item.title}</span>
                <span className="text-meta text-[10px]">
                  {kindLabels[item.kind] || item.kind}
                </span>
                <span
                  className={`text-[10px] px-1 rounded ${
                    envColors[item.env_tag] || "text-meta"
                  }`}
                >
                  {item.env_tag}
                </span>
                <span
                  className={`text-[10px] ${riskColors[item.risk_level] || "text-meta"}`}
                >
                  {item.risk_level}
                </span>
              </div>
              {item.tags.length > 0 && (
                <div className="flex gap-1 mb-1 flex-wrap">
                  {item.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 text-[10px] bg-surface rounded-full text-meta"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div
                className="text-fg-2 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: item.snippet }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

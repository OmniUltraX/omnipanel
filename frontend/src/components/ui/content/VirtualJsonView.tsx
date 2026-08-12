import { useMemo } from "react";
import { JsonView, defaultStyles } from "react-json-view-lite";
import { getTextSearchMatchIndices } from "../../../lib/textSearchMatch";
import { cn } from "../../../lib/utils";
import { useScopedSearchQuery } from "../search/ScopedSearch";
import "./VirtualJsonView.css";

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
  /** 默认展开层级深度，默认 2 */
  expandDepth?: number;
}

/** 与应用主题变量对齐的 JSON 树样式（替代库内置 defaultStyles / darkStyles） */
const OMNI_JSON_VIEW_STYLES: typeof defaultStyles = {
  container: "json-view-container",
  basicChildStyle: "json-view-child",
  childFieldsContainer: "json-view-child-fields",
  label: "json-view-label",
  clickableLabel: "json-view-label json-view-label-clickable",
  nullValue: "json-view-null",
  undefinedValue: "json-view-undefined",
  stringValue: "json-view-string",
  numberValue: "json-view-number",
  booleanValue: "json-view-boolean",
  otherValue: "json-view-other",
  punctuation: "json-view-punctuation",
  expandIcon: "json-view-expand-icon",
  collapseIcon: "json-view-collapse-icon",
  collapsedContent: "json-view-collapsed-content",
  noQuotesForStringValues: false,
  quotesForFieldNames: false,
  ariaLables: {
    collapseJson: "折叠 JSON",
    expandJson: "展开 JSON",
  },
  stringifyStringValues: false,
};

/** 子树（含对象键）是否包含搜索匹配，用于搜索时自动展开路径。 */
function jsonSubtreeContainsQuery(value: unknown, query: string): boolean {
  const needle = query.trim();
  if (!needle) {
    return false;
  }
  if (typeof value === "string") {
    return getTextSearchMatchIndices(value, needle).length > 0;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return getTextSearchMatchIndices(String(value), needle).length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => jsonSubtreeContainsQuery(item, needle));
  }
  if (typeof value === "object" && value) {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) =>
        getTextSearchMatchIndices(key, needle).length > 0 ||
        jsonSubtreeContainsQuery(child, needle),
    );
  }
  return false;
}

export function VirtualJsonView({
  value,
  className,
  expandDepth = 2,
}: VirtualJsonViewProps) {
  const searchQuery = useScopedSearchQuery();
  const needle = searchQuery.trim();

  const shouldExpandNode = useMemo(() => {
    if (!needle) {
      return (level: number) => level < expandDepth;
    }
    return (level: number, nodeValue: unknown, field?: string) => {
      if (field && getTextSearchMatchIndices(field, needle).length > 0) {
        return true;
      }
      // 限制极端展开深度，避免超大 JSON 在命中过多时卡死
      if (level > 24) {
        return false;
      }
      return jsonSubtreeContainsQuery(nodeValue, needle);
    };
  }, [expandDepth, needle]);

  return (
    <div className={cn("virtual-json-view", className)}>
      <JsonView
        key={needle ? `search:${needle}` : "default"}
        data={value}
        style={OMNI_JSON_VIEW_STYLES}
        shouldExpandNode={shouldExpandNode}
      />
    </div>
  );
}

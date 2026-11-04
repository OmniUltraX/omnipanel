import { useEffect, useMemo, useState } from "react";
import { JsonView, collapseAllNested, defaultStyles } from "react-json-view-lite";
import { useI18n } from "../../../i18n";
import { getTextSearchMatchIndices } from "../../../lib/textSearchMatch";
import { cn } from "../../../lib/utils";
import { useScopedSearchQuery } from "../search/ScopedSearch";
import "./VirtualJsonView.css";

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
  /** 默认展开层级深度，默认 2 */
  expandDepth?: number;
  /** 是否显示全部展开 / 收起工具条，默认 true */
  showExpandControls?: boolean;
}

type ExpandPreset = "default" | "all" | "collapsed";

/** 全部展开时的深度上限，避免超大 JSON 卡死 */
const EXPAND_ALL_MAX_DEPTH = 32;

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
  showExpandControls = true,
}: VirtualJsonViewProps) {
  const { t } = useI18n();
  const searchQuery = useScopedSearchQuery();
  const needle = searchQuery.trim();
  const [expandPreset, setExpandPreset] = useState<ExpandPreset>("default");

  useEffect(() => {
    setExpandPreset("default");
  }, [value]);

  const shouldExpandNode = useMemo(() => {
    if (needle) {
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
    }
    if (expandPreset === "all") {
      return (level: number) => level < EXPAND_ALL_MAX_DEPTH;
    }
    if (expandPreset === "collapsed") {
      return collapseAllNested;
    }
    return (level: number) => level < expandDepth;
  }, [expandDepth, expandPreset, needle]);

  const viewKey = needle
    ? `search:${needle}`
    : expandPreset === "default"
      ? `default:${expandDepth}`
      : expandPreset;

  return (
    <div className={cn("virtual-json-view", className)}>
      {showExpandControls && !needle ? (
        <div className="virtual-json-view-toolbar" role="toolbar" aria-label={t("contentPreview.jsonExpandToolbar")}>
          <button
            type="button"
            className={cn(
              "virtual-json-view-toolbar-btn",
              expandPreset === "all" && "is-active",
            )}
            aria-pressed={expandPreset === "all"}
            onClick={() => setExpandPreset("all")}
          >
            {t("contentPreview.expandAll")}
          </button>
          <button
            type="button"
            className={cn(
              "virtual-json-view-toolbar-btn",
              expandPreset === "collapsed" && "is-active",
            )}
            aria-pressed={expandPreset === "collapsed"}
            onClick={() => setExpandPreset("collapsed")}
          >
            {t("contentPreview.collapseAll")}
          </button>
        </div>
      ) : null}
      <div className="virtual-json-view-body">
        <JsonView
          key={viewKey}
          data={value}
          style={OMNI_JSON_VIEW_STYLES}
          shouldExpandNode={shouldExpandNode}
        />
      </div>
    </div>
  );
}

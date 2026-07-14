import { useEffect, useMemo, useState } from "react";
import { JsonView, darkStyles, defaultStyles } from "react-json-view-lite";
import { isLightTheme } from "../../../modules/database/sql/sqlEditorTheme";
import { getTextSearchMatchIndices } from "../../../lib/textSearchMatch";
import { cn } from "../../../lib/utils";
import { useScopedSearchQuery } from "../search/ScopedSearch";

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
  /** 默认展开层级深度，默认 2 */
  expandDepth?: number;
}

function useJsonViewThemeStyles(): typeof defaultStyles {
  const [light, setLight] = useState(() => isLightTheme());

  useEffect(() => {
    const sync = () => setLight(isLightTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return light ? defaultStyles : darkStyles;
}

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
  const style = useJsonViewThemeStyles();
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
        style={style}
        shouldExpandNode={shouldExpandNode}
      />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  JsonView,
  darkStyles,
  defaultStyles,
  type StyleProps,
} from "react-json-view-lite";
import { isLightTheme } from "../../../modules/database/sql/sqlEditorTheme";
import { cn } from "../../../lib/utils";

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
  /** 初始展开层级，默�?2 */
  expandDepth?: number;
}

function useJsonViewThemeStyles(): StyleProps {
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

export function VirtualJsonView({
  value,
  className,
  expandDepth = 2,
}: VirtualJsonViewProps) {
  const style = useJsonViewThemeStyles();
  const shouldExpandNode = useMemo(
    () => (level: number) => level < expandDepth,
    [expandDepth],
  );

  return (
    <div className={cn("virtual-json-view", className)}>
      <JsonView data={value} style={style} shouldExpandNode={shouldExpandNode} />
    </div>
  );
}

import { useMemo } from "react";
import { ObjectView } from "react-obj-view";
import { themeGitHubLight, themeOneDark } from "react-obj-view";
import "react-obj-view/dist/react-obj-view.css";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";

/** 与 CSS `--bigobjview-fontsize` / 行高保持一致，避免虚拟滚动错位 */
const VIRTUAL_JSON_LINE_HEIGHT = 20;
const VIRTUAL_JSON_ARRAY_GROUP = 1000;
const VIRTUAL_JSON_OBJECT_GROUP = 100;

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
  /** 初始展开层级，默认仅展开根节点 */
  expandLevel?: number;
}

/** 大体积 JSON 虚拟树预览（react-obj-view） */
export function VirtualJsonView({
  value,
  className,
  expandLevel = 1,
}: VirtualJsonViewProps) {
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const valueGetter = useMemo(() => () => value, [value]);
  const preset = resolvedTheme === "dark" ? themeOneDark : themeGitHubLight;

  return (
    <ObjectView
      valueGetter={valueGetter}
      expandLevel={expandLevel}
      arrayGroupSize={VIRTUAL_JSON_ARRAY_GROUP}
      objectGroupSize={VIRTUAL_JSON_OBJECT_GROUP}
      lineHeight={VIRTUAL_JSON_LINE_HEIGHT}
      highlightUpdate={false}
      stickyPathHeaders
      preview
      style={{
        ...preset,
        fontSize: 12,
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
      }}
      className={cn("virtual-json-view", className)}
    />
  );
}

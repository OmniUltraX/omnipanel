import { useEffect, useRef } from "react";
import MindMap from "simple-mind-map";
import "simple-mind-map/dist/simpleMindMap.esm.css";
import { useI18n } from "../../../i18n";
import { readTreeDiagramTheme, watchTreeDiagramTheme } from "./treeDiagramTheme";

interface TreeDiagramPanelProps {
  label?: string;
}

const SAMPLE_TREE_DATA = {
  data: {
    text: "示例根节点",
  },
  children: [
    {
      data: { text: "连接 A" },
      children: [
        { data: { text: "数据库 db1" } },
        { data: { text: "数据库 db2" } },
      ],
    },
    {
      data: { text: "连接 B" },
      children: [
        { data: { text: "表 users" } },
        { data: { text: "表 orders" } },
      ],
    },
  ],
};

export function TreeDiagramPanel({ label }: TreeDiagramPanelProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const mindMapRef = useRef<MindMap | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = readTreeDiagramTheme(container);
    const themeConfig = {
      backgroundColor: theme.canvasBg,
      lineColor: theme.edgeFallback,
      lineWidth: 2,
      root: {
        fillColor: theme.rootFill,
        color: theme.rootLabelFill,
        borderColor: theme.rootStroke,
        borderWidth: 1,
      },
      second: {
        fillColor: theme.nodeFill,
        color: theme.labelFill,
        borderColor: theme.nodeStroke,
        borderWidth: 1,
      },
      node: {
        fillColor: theme.nodeFill,
        color: theme.labelFill,
        borderColor: theme.nodeStroke,
        borderWidth: 1,
      },
    };

    mindMapRef.current = new MindMap({
      el: container,
      data: SAMPLE_TREE_DATA,
      themeConfig,
    } as any);

    const applyTheme = () => {
      const newTheme = readTreeDiagramTheme(container);
      mindMapRef.current?.setThemeConfig({
        backgroundColor: newTheme.canvasBg,
        lineColor: newTheme.edgeFallback,
        lineWidth: 2,
        root: {
          fillColor: newTheme.rootFill,
          color: newTheme.rootLabelFill,
          borderColor: newTheme.rootStroke,
          borderWidth: 1,
        },
        second: {
          fillColor: newTheme.nodeFill,
          color: newTheme.labelFill,
          borderColor: newTheme.nodeStroke,
          borderWidth: 1,
        },
        node: {
          fillColor: newTheme.nodeFill,
          color: newTheme.labelFill,
          borderColor: newTheme.nodeStroke,
          borderWidth: 1,
        },
      });
    };

    const stopThemeWatch = watchTreeDiagramTheme(applyTheme);

    return () => {
      stopThemeWatch();
      mindMapRef.current?.destroy();
      mindMapRef.current = null;
    };
  }, []);

  return (
    <div className="db-tree-diagram-panel">
      <div className="db-tree-diagram-panel__header">
        <h3 className="db-tree-diagram-panel__title">{label ?? t("database.queryFiles.defaultTreeFileName")}</h3>
        <p className="db-tree-diagram-panel__hint">{t("database.treeDiagram.placeholderHint")}</p>
      </div>
      <div ref={containerRef} className="db-tree-diagram-panel__canvas" />
    </div>
  );
}

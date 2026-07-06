import { useEffect, useRef } from "react";
import type { Graph } from "@antv/g6";
import { useI18n } from "../../../i18n";
import {
  createMindmapGraph,
  renderMindmapGraph,
  refreshMindmapGraphTheme,
  SAMPLE_TREE_DATA,
  type MindmapGraphSession,
} from "./g6MindmapSetup";
import { watchTreeDiagramTheme } from "./treeDiagramTheme";

interface TreeDiagramPanelProps {
  label?: string;
}

export function TreeDiagramPanel({ label }: TreeDiagramPanelProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    // React StrictMode 重挂载时清理残留画布
    container.replaceChildren();

    const session: MindmapGraphSession = { disposed: false };
    const graph = createMindmapGraph(container, SAMPLE_TREE_DATA);
    graphRef.current = graph;

    const renderPromise = renderMindmapGraph(graph, session);

    const resizeObserver = new ResizeObserver((entries) => {
      if (session.disposed || graph.destroyed) return;
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        try {
          graph.setSize(width, height);
        } catch {
          // 图已销毁时忽略
        }
      }
    });
    resizeObserver.observe(container);

    const stopThemeWatch = watchTreeDiagramTheme(() => {
      if (session.disposed || graph.destroyed) return;
      void refreshMindmapGraphTheme(graph);
    });

    return () => {
      stopThemeWatch();
      session.disposed = true;
      resizeObserver.disconnect();
      void renderPromise.finally(() => {
        if (!graph.destroyed) {
          graph.destroy();
        }
      });
      graphRef.current = null;
    };
  }, []);

  return (
    <div className="db-tree-diagram-panel">
      <div className="db-tree-diagram-panel__header">
        <h3 className="db-tree-diagram-panel__title">{label ?? t("database.queryFiles.defaultTreeFileName")}</h3>
        <p className="db-tree-diagram-panel__hint">{t("database.treeDiagram.placeholderHint")}</p>
      </div>
      <div ref={canvasRef} className="db-tree-diagram-panel__canvas" />
    </div>
  );
}

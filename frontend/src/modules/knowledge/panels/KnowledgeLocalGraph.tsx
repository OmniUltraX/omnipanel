import { useMemo } from "react";
import { useI18n } from "../../../i18n";
import type { KnowledgeMetadataSnapshot } from "../metadata/KnowledgeMetadataCache";

interface KnowledgeLocalGraphProps {
  entryId: string;
  entryTitle: string;
  meta: KnowledgeMetadataSnapshot;
  onOpen: (entryId: string) => void;
}

type GraphNode = { id: string; title: string; kind: "center" | "out" | "in" };

export function KnowledgeLocalGraph({
  entryId,
  entryTitle,
  meta,
  onOpen,
}: KnowledgeLocalGraphProps) {
  const { t } = useI18n();

  const nodes = useMemo(() => {
    const map = new Map<string, GraphNode>();
    map.set(entryId, { id: entryId, title: entryTitle, kind: "center" });

    for (const link of meta.outgoing.get(entryId) ?? []) {
      const id = meta.titleToId.get(link.targetTitle.trim().toLowerCase());
      if (!id || id === entryId) continue;
      if (!map.has(id)) {
        map.set(id, {
          id,
          title: meta.idToTitle.get(id) ?? link.targetTitle,
          kind: "out",
        });
      }
    }
    for (const mention of meta.backlinks.get(entryId) ?? []) {
      if (mention.sourceId === entryId) continue;
      if (!map.has(mention.sourceId)) {
        map.set(mention.sourceId, {
          id: mention.sourceId,
          title: mention.sourceTitle,
          kind: "in",
        });
      }
    }
    return [...map.values()];
  }, [entryId, entryTitle, meta]);

  if (nodes.length <= 1) {
    return <div className="knowledge-rail-empty">{t("knowledge.graph.empty")}</div>;
  }

  const others = nodes.filter((n) => n.kind !== "center");
  const cx = 120;
  const cy = 110;
  const radius = 72;

  return (
    <div className="knowledge-local-graph">
      <svg viewBox="0 0 240 220" className="knowledge-local-graph__svg" role="img">
        {others.map((node, index) => {
          const angle = (Math.PI * 2 * index) / others.length - Math.PI / 2;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          return (
            <g key={node.id}>
              <line
                x1={cx}
                y1={cy}
                x2={x}
                y2={y}
                className={
                  node.kind === "in"
                    ? "knowledge-local-graph__edge knowledge-local-graph__edge--in"
                    : "knowledge-local-graph__edge"
                }
              />
              <circle
                cx={x}
                cy={y}
                r={16}
                className={
                  node.kind === "in"
                    ? "knowledge-local-graph__node knowledge-local-graph__node--in"
                    : "knowledge-local-graph__node knowledge-local-graph__node--out"
                }
                onClick={() => onOpen(node.id)}
              />
              <text
                x={x}
                y={y + 28}
                textAnchor="middle"
                className="knowledge-local-graph__label"
                onClick={() => onOpen(node.id)}
              >
                {node.title.length > 8 ? `${node.title.slice(0, 8)}…` : node.title}
              </text>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r={20} className="knowledge-local-graph__node knowledge-local-graph__node--center" />
        <text x={cx} y={cy + 4} textAnchor="middle" className="knowledge-local-graph__label knowledge-local-graph__label--center">
          {entryTitle.length > 6 ? `${entryTitle.slice(0, 6)}…` : entryTitle}
        </text>
      </svg>
      <div className="knowledge-local-graph__legend">
        <span>{t("knowledge.graph.outgoing")}</span>
        <span>{t("knowledge.graph.incoming")}</span>
      </div>
    </div>
  );
}

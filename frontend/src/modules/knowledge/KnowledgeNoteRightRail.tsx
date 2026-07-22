import { useI18n } from "../../i18n";
import type { KnowledgeMetadataSnapshot } from "./metadata/KnowledgeMetadataCache";
import type { ParsedHeading } from "./metadata/headings";
import type { LinkMention } from "./metadata/KnowledgeMetadataCache";
import { KnowledgeOutlinePanel } from "./panels/KnowledgeOutlinePanel";
import { KnowledgeBacklinksPanel } from "./panels/KnowledgeBacklinksPanel";
import { KnowledgeLocalGraph } from "./panels/KnowledgeLocalGraph";

export type KnowledgeRightRailTab = "outline" | "backlinks" | "graph";

interface KnowledgeNoteRightRailProps {
  tab: KnowledgeRightRailTab;
  onTabChange: (tab: KnowledgeRightRailTab) => void;
  onCollapse: () => void;
  headings: ParsedHeading[];
  onJumpHeading: (heading: ParsedHeading) => void;
  linked: LinkMention[];
  unlinked: LinkMention[];
  onOpenEntry: (entryId: string) => void;
  entryId: string;
  entryTitle: string;
  meta: KnowledgeMetadataSnapshot;
}

export function KnowledgeNoteRightRail({
  tab,
  onTabChange,
  onCollapse,
  headings,
  onJumpHeading,
  linked,
  unlinked,
  onOpenEntry,
  entryId,
  entryTitle,
  meta,
}: KnowledgeNoteRightRailProps) {
  const { t } = useI18n();

  return (
    <aside className="knowledge-note-rail">
      <div className="knowledge-note-rail__tabs">
        {(
          [
            ["outline", t("knowledge.rail.outline")],
            ["backlinks", t("knowledge.rail.backlinks")],
            ["graph", t("knowledge.rail.graph")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`knowledge-note-rail__tab${tab === id ? " is-active" : ""}`}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="knowledge-note-rail__collapse"
          title={t("knowledge.rail.collapse")}
          aria-label={t("knowledge.rail.collapse")}
          onClick={onCollapse}
        >
          ›
        </button>
      </div>
      <div className="knowledge-note-rail__body">
        {tab === "outline" ? (
          <KnowledgeOutlinePanel headings={headings} onJump={onJumpHeading} />
        ) : null}
        {tab === "backlinks" ? (
          <KnowledgeBacklinksPanel linked={linked} unlinked={unlinked} onOpen={onOpenEntry} />
        ) : null}
        {tab === "graph" ? (
          <KnowledgeLocalGraph
            entryId={entryId}
            entryTitle={entryTitle}
            meta={meta}
            onOpen={onOpenEntry}
          />
        ) : null}
      </div>
    </aside>
  );
}

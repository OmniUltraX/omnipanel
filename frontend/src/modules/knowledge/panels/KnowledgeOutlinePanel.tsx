import { useI18n } from "../../../i18n";
import type { ParsedHeading } from "../metadata/headings";

interface KnowledgeOutlinePanelProps {
  headings: ParsedHeading[];
  onJump: (heading: ParsedHeading) => void;
}

export function KnowledgeOutlinePanel({ headings, onJump }: KnowledgeOutlinePanelProps) {
  const { t } = useI18n();

  if (headings.length === 0) {
    return <div className="knowledge-rail-empty">{t("knowledge.outline.empty")}</div>;
  }

  return (
    <ul className="knowledge-outline-list">
      {headings.map((heading, index) => (
        <li key={`${heading.line}-${index}`}>
          <button
            type="button"
            className="knowledge-outline-item"
            style={{ paddingLeft: 8 + (heading.level - 1) * 12 }}
            onClick={() => onJump(heading)}
            title={heading.text}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

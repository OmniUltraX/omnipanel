import { useI18n } from "../../../i18n";
import type { LinkMention } from "../metadata/KnowledgeMetadataCache";

interface KnowledgeBacklinksPanelProps {
  linked: LinkMention[];
  unlinked: LinkMention[];
  onOpen: (entryId: string) => void;
}

export function KnowledgeBacklinksPanel({ linked, unlinked, onOpen }: KnowledgeBacklinksPanelProps) {
  const { t } = useI18n();

  return (
    <div className="knowledge-backlinks">
      <section className="knowledge-backlinks__section">
        <h4 className="knowledge-backlinks__heading">{t("knowledge.backlinks.linked")}</h4>
        {linked.length === 0 ? (
          <div className="knowledge-rail-empty">{t("knowledge.backlinks.linkedEmpty")}</div>
        ) : (
          <ul className="knowledge-backlinks__list">
            {linked.map((item) => (
              <li key={`${item.sourceId}-${item.link.index}`}>
                <button
                  type="button"
                  className="knowledge-backlinks__item"
                  onClick={() => onOpen(item.sourceId)}
                >
                  <span className="knowledge-backlinks__title">{item.sourceTitle}</span>
                  <span className="knowledge-backlinks__snippet">{item.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="knowledge-backlinks__section">
        <h4 className="knowledge-backlinks__heading">{t("knowledge.backlinks.unlinked")}</h4>
        {unlinked.length === 0 ? (
          <div className="knowledge-rail-empty">{t("knowledge.backlinks.unlinkedEmpty")}</div>
        ) : (
          <ul className="knowledge-backlinks__list">
            {unlinked.map((item) => (
              <li key={`u-${item.sourceId}-${item.link.index}`}>
                <button
                  type="button"
                  className="knowledge-backlinks__item"
                  onClick={() => onOpen(item.sourceId)}
                >
                  <span className="knowledge-backlinks__title">{item.sourceTitle}</span>
                  <span className="knowledge-backlinks__snippet">{item.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

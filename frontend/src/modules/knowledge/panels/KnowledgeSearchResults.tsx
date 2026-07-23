import type { KnowledgeSearchResult } from "../../../ipc/bindings";
import { useI18n } from "../../../i18n";

interface KnowledgeSearchResultsProps {
  results: KnowledgeSearchResult[];
  loading?: boolean;
  onOpen: (entryId: string) => void;
}

function SnippetHtml({ html }: { html: string }) {
  return (
    <span
      className="knowledge-search-result__snippet"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function KnowledgeSearchResults({
  results,
  loading,
  onOpen,
}: KnowledgeSearchResultsProps) {
  const { t } = useI18n();

  if (loading) {
    return <div className="knowledge-rail-empty">{t("knowledge.search.loading")}</div>;
  }

  if (results.length === 0) {
    return <div className="knowledge-rail-empty">{t("knowledge.noResults")}</div>;
  }

  return (
    <ul className="knowledge-search-results">
      {results.map((item) => (
        <li key={item.entry.id}>
          <button
            type="button"
            className="knowledge-search-result"
            onClick={() => onOpen(item.entry.id)}
          >
            <span className="knowledge-search-result__title">{item.entry.title}</span>
            <SnippetHtml html={item.snippet} />
          </button>
        </li>
      ))}
    </ul>
  );
}

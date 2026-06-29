import { useCallback, useEffect, useState } from "react";
import { useKnowledgeEmbeddingProviderConfig } from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { SubWindow } from "../../components/ui/SubWindow";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { KnowledgeRecallHit } from "../../ipc/bindings";
import { recallKnowledgeEntry } from "./knowledgeVectorize";

interface KnowledgeRecallTestSubWindowProps {
  open: boolean;
  entryId: string;
  entryTitle: string;
  onClose: () => void;
}

function formatScore(score: number): string {
  const pct = Math.max(0, Math.min(100, score * 100));
  return `${pct.toFixed(1)}%`;
}

function scoreBarWidth(score: number): string {
  const pct = Math.max(0, Math.min(100, score * 100));
  return `${pct}%`;
}

export function KnowledgeRecallTestSubWindow({
  open,
  entryId,
  entryTitle,
  onClose,
}: KnowledgeRecallTestSubWindowProps) {
  const { t } = useI18n();
  const embeddingProvider = useKnowledgeEmbeddingProviderConfig();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeRecallHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setError(null);
    setHasSearched(false);
    setLoading(false);
  }, [open, entryId]);

  const handleRun = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setError(t("knowledge.chunks.recall.queryRequired"));
      return;
    }
    if (!embeddingProvider) {
      setError(t("knowledge.vectorize.noModel"));
      return;
    }

    setLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      const hits = await recallKnowledgeEntry(entryId, trimmed, embeddingProvider);
      setResults(hits);
    } catch (e) {
      setResults([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [embeddingProvider, entryId, query, t]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void handleRun();
    }
  };

  return (
    <SubWindow
      open={open}
      title={t("knowledge.chunks.recall.title", { title: entryTitle })}
      onClose={onClose}
      className="knowledge-recall-subwindow"
      widthRatio={0.72}
      heightRatio={0.78}
    >
      <div className="knowledge-recall-panel">
        <section className="knowledge-recall-panel__query">
          <label className="knowledge-recall-panel__label" htmlFor="knowledge-recall-query">
            {t("knowledge.chunks.recall.queryLabel")}
          </label>
          <textarea
            id="knowledge-recall-query"
            className="knowledge-recall-panel__textarea"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("knowledge.chunks.recall.queryPlaceholder")}
            rows={4}
            disabled={loading}
          />
          <div className="knowledge-recall-panel__actions">
            <span className="knowledge-recall-panel__hint">
              {t("knowledge.chunks.recall.runHint")}
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={loading || !query.trim() || !embeddingProvider}
              onClick={() => void handleRun()}
            >
              {loading ? t("knowledge.chunks.recall.running") : t("knowledge.chunks.recall.run")}
            </Button>
          </div>
        </section>

        {error ? (
          <div className="knowledge-recall-panel__error">{error}</div>
        ) : null}

        <section className="knowledge-recall-panel__results">
          {loading ? (
            <div className="knowledge-recall-panel__empty">{t("knowledge.chunks.recall.running")}</div>
          ) : hasSearched && results.length === 0 && !error ? (
            <div className="knowledge-recall-panel__empty">{t("knowledge.chunks.recall.noResults")}</div>
          ) : results.length > 0 ? (
            <ul className="knowledge-recall-panel__list">
              {results.map((hit) => (
                <li key={hit.id} className="knowledge-recall-panel__item">
                  <div className="knowledge-recall-panel__item-head">
                    <span className="knowledge-recall-panel__item-index">
                      {t("knowledge.chunks.blockIndex", { index: (hit.chunkIndex ?? 0) + 1 })}
                    </span>
                    <div className="knowledge-recall-panel__score-wrap">
                      <span className="knowledge-recall-panel__score-label">
                        {t("knowledge.chunks.recall.score")}
                      </span>
                      <span className="knowledge-recall-panel__score-value">
                        {formatScore(hit.score)}
                      </span>
                      <div className="knowledge-recall-panel__score-bar" aria-hidden>
                        <span
                          className="knowledge-recall-panel__score-bar-fill"
                          style={{ width: scoreBarWidth(hit.score) }}
                        />
                      </div>
                    </div>
                  </div>
                  <pre className="knowledge-recall-panel__item-body">{hit.content}</pre>
                </li>
              ))}
            </ul>
          ) : (
            <div className="knowledge-recall-panel__empty">{t("knowledge.chunks.recall.intro")}</div>
          )}
        </section>
      </div>
    </SubWindow>
  );
}

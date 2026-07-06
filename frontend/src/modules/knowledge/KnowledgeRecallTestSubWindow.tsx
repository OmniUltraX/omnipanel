import { useCallback, useEffect, useState } from "react";
import { useKnowledgeEmbeddingProviderConfig } from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { SubWindow } from "../../components/ui/SubWindow";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { KnowledgeRecallHit } from "../../ipc/bindings";
import { recallKnowledgeEntry, KNOWLEDGE_RECALL_DEFAULT_MIN_SCORE_PERCENT, KNOWLEDGE_RECALL_DEFAULT_TOP_K, KNOWLEDGE_RECALL_TOP_K_MAX, KNOWLEDGE_RECALL_TOP_K_MIN } from "./knowledgeVectorize";

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

function clampTopK(value: number): number {
  if (!Number.isFinite(value)) {
    return KNOWLEDGE_RECALL_DEFAULT_TOP_K;
  }
  return Math.min(KNOWLEDGE_RECALL_TOP_K_MAX, Math.max(KNOWLEDGE_RECALL_TOP_K_MIN, Math.round(value)));
}

function clampMinScorePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
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
  const [topK, setTopK] = useState(KNOWLEDGE_RECALL_DEFAULT_TOP_K);
  const [minScorePercent, setMinScorePercent] = useState(KNOWLEDGE_RECALL_DEFAULT_MIN_SCORE_PERCENT);
  const [results, setResults] = useState<KnowledgeRecallHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTopK(KNOWLEDGE_RECALL_DEFAULT_TOP_K);
    setMinScorePercent(KNOWLEDGE_RECALL_DEFAULT_MIN_SCORE_PERCENT);
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
      const hits = await recallKnowledgeEntry(entryId, trimmed, embeddingProvider, {
        topK: clampTopK(topK),
        minScore: clampMinScorePercent(minScorePercent) / 100,
      });
      setResults(hits);
    } catch (e) {
      setResults([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [embeddingProvider, entryId, minScorePercent, query, topK, t]);

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
          <div className="knowledge-recall-panel__params">
            <label className="knowledge-recall-panel__param">
              <span className="knowledge-recall-panel__param-label">
                {t("knowledge.chunks.recall.topK")}
              </span>
              <input
                type="number"
                className="knowledge-recall-panel__param-input"
                min={KNOWLEDGE_RECALL_TOP_K_MIN}
                max={KNOWLEDGE_RECALL_TOP_K_MAX}
                step={1}
                value={topK}
                disabled={loading}
                title={t("knowledge.chunks.recall.topKHint")}
                onChange={(event) => setTopK(clampTopK(Number(event.target.value)))}
              />
            </label>
            <label className="knowledge-recall-panel__param">
              <span className="knowledge-recall-panel__param-label">
                {t("knowledge.chunks.recall.minScore")}
              </span>
              <div className="knowledge-recall-panel__param-with-suffix">
                <input
                  type="number"
                  className="knowledge-recall-panel__param-input"
                  min={0}
                  max={100}
                  step={1}
                  value={minScorePercent}
                  disabled={loading}
                  title={t("knowledge.chunks.recall.minScoreHint")}
                  onChange={(event) =>
                    setMinScorePercent(clampMinScorePercent(Number(event.target.value)))
                  }
                />
                <span className="knowledge-recall-panel__param-suffix" aria-hidden>
                  %
                </span>
              </div>
            </label>
          </div>
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
            <div className="knowledge-chunks-panel__grid knowledge-recall-panel__grid">
              {results.map((hit) => (
                <article key={hit.id} className="knowledge-chunk-card knowledge-chunk-card--recall">
                  <div className="knowledge-chunk-card__head">
                    <span className="knowledge-chunk-card__index">
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
                  <pre className="knowledge-chunk-card__body">{hit.content}</pre>
                </article>
              ))}
            </div>
          ) : (
            <div className="knowledge-recall-panel__empty">{t("knowledge.chunks.recall.intro")}</div>
          )}
        </section>
      </div>
    </SubWindow>
  );
}

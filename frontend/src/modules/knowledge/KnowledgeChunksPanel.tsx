import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { Button } from "../../components/ui/Button";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import {
  deleteKnowledgeChunks,
  KNOWLEDGE_CHUNK_PAGE_SIZE,
  KNOWLEDGE_VECTORIZED_EVENT,
  loadKnowledgeChunksPage,
  loadKnowledgeVectorStatus,
  type KnowledgeChunkPreview,
} from "./knowledgeVectorize";
import { isKnowledgeFolder } from "./knowledgeTree";
import { KnowledgeChunksPagination } from "./KnowledgeChunksPagination";
import { KnowledgeRecallTestSubWindow } from "./KnowledgeRecallTestSubWindow";

interface KnowledgeChunksPanelProps {
  entryId: string;
}

function formatEmbeddedAt(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function ChunkDeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}

export function KnowledgeChunksPanel({ entryId }: KnowledgeChunksPanelProps) {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const entry = useMemo(
    () => entries.find((item) => item.id === entryId) ?? null,
    [entries, entryId],
  );

  const [chunks, setChunks] = useState<KnowledgeChunkPreview[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [embeddedAt, setEmbeddedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [recallOpen, setRecallOpen] = useState(false);
  const anchorIdRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorIdRef.current = null;
  }, []);

  const loadPage = useCallback(
    async (targetPage: number) => {
      if (!entry || isKnowledgeFolder(entry)) {
        setChunks([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [status, result] = await Promise.all([
          loadKnowledgeVectorStatus(entry.id),
          loadKnowledgeChunksPage(entry.id, targetPage),
        ]);
        setEmbeddedAt(status?.embeddedAt ?? null);

        const resultTotal = result.total ?? 0;
        const totalPages = Math.max(1, Math.ceil(resultTotal / KNOWLEDGE_CHUNK_PAGE_SIZE));
        const safePage = Math.min(Math.max(1, targetPage), totalPages);

        if (safePage !== targetPage && resultTotal > 0) {
          const corrected = await loadKnowledgeChunksPage(entry.id, safePage);
          setTotal(corrected.total ?? 0);
          setChunks(corrected.chunks);
        } else {
          setTotal(resultTotal);
          setChunks(result.chunks);
        }
        setPage(safePage);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setChunks([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [entry],
  );

  useEffect(() => {
    setPage(1);
    clearSelection();
    void loadPage(1);
  }, [entry?.id, loadPage, clearSelection]);

  useEffect(() => {
    clearSelection();
  }, [page, clearSelection]);

  useEffect(() => {
    if (!entry || isKnowledgeFolder(entry)) return;
    const onVectorized = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId: string }>).detail;
      if (detail?.entryId === entry.id) {
        setPage(1);
        clearSelection();
        void loadPage(1);
      }
    };
    window.addEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    return () => window.removeEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
  }, [entry, loadPage, clearSelection]);

  const handlePageChange = useCallback(
    (nextPage: number) => {
      void loadPage(nextPage);
    },
    [loadPage],
  );

  const handleDeleteChunks = useCallback(
    async (chunkIds: string[]) => {
      if (!entry || isKnowledgeFolder(entry) || chunkIds.length === 0 || deleting) return;

      const message =
        chunkIds.length === 1
          ? t("knowledge.chunks.confirmDeleteOne")
          : t("knowledge.chunks.confirmDelete", { count: chunkIds.length });
      if (!(await appConfirm(message))) return;

      setDeleting(true);
      try {
        const result = await deleteKnowledgeChunks(entry.id, chunkIds);
        clearSelection();
        if (result.remaining <= 0) {
          setTotal(0);
          setChunks([]);
          setPage(1);
          return;
        }
        const totalPages = Math.max(1, Math.ceil(result.remaining / KNOWLEDGE_CHUNK_PAGE_SIZE));
        const targetPage = Math.min(page, totalPages);
        await loadPage(targetPage);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDeleting(false);
      }
    },
    [clearSelection, deleting, entry, loadPage, page, t],
  );

  const handleChunkClick = useCallback(
    (chunk: KnowledgeChunkPreview, event: ReactMouseEvent) => {
      if ((event.target as HTMLElement).closest(".knowledge-chunk-card__delete")) {
        return;
      }

      const id = chunk.id;
      const currentIndex = chunks.findIndex((item) => item.id === id);

      if (event.shiftKey && anchorIdRef.current) {
        const anchorIndex = chunks.findIndex((item) => item.id === anchorIdRef.current);
        if (anchorIndex >= 0 && currentIndex >= 0) {
          const from = Math.min(anchorIndex, currentIndex);
          const to = Math.max(anchorIndex, currentIndex);
          const rangeIds = chunks.slice(from, to + 1).map((item) => item.id);
          setSelectedIds((prev) => {
            if (event.ctrlKey || event.metaKey) {
              const next = new Set(prev);
              for (const rangeId of rangeIds) {
                next.add(rangeId);
              }
              return next;
            }
            return new Set(rangeIds);
          });
          return;
        }
      }

      if (event.ctrlKey || event.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        anchorIdRef.current = id;
        return;
      }

      setSelectedIds(new Set([id]));
      anchorIdRef.current = id;
    },
    [chunks],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || selectedIds.size === 0 || deleting) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((event.target as HTMLElement | null)?.isContentEditable) return;
      if (!panelRef.current) return;

      event.preventDefault();
      event.stopPropagation();
      void handleDeleteChunks(Array.from(selectedIds));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [deleting, handleDeleteChunks, selectedIds]);

  const selectedCount = selectedIds.size;

  if (!entry || isKnowledgeFolder(entry)) {
    return (
      <div className="knowledge-chunks-panel knowledge-chunks-panel--empty">
        {t("knowledge.chunks.entryMissing")}
      </div>
    );
  }

  if (loading && chunks.length === 0 && total === 0) {
    return (
      <div className="knowledge-chunks-panel knowledge-chunks-panel--empty">
        {t("knowledge.chunks.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="knowledge-chunks-panel knowledge-chunks-panel--empty knowledge-chunks-panel--error">
        {error}
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="knowledge-chunks-panel knowledge-chunks-panel--empty">
        {t("knowledge.chunks.empty")}
      </div>
    );
  }

  return (
    <div className="knowledge-chunks-panel" ref={panelRef}>
      <header className="knowledge-chunks-panel__header">
        <div className="knowledge-chunks-panel__header-main">
          <h2 className="knowledge-chunks-panel__title">{entry.title}</h2>
          <p className="knowledge-chunks-panel__meta">
            {selectedCount > 0
              ? t("knowledge.chunks.selectedSummary", { selected: selectedCount, total })
              : t("knowledge.chunks.summary", {
                  count: total,
                  time: formatEmbeddedAt(embeddedAt ?? 0),
                })}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setRecallOpen(true)}
        >
          {t("knowledge.chunks.recall.open")}
        </Button>
      </header>

      <div
        className={`knowledge-chunks-panel__grid${loading || deleting ? " knowledge-chunks-panel__grid--loading" : ""}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".knowledge-chunk-card")) return;
          clearSelection();
        }}
      >
        {chunks.map((chunk) => {
          const selected = selectedIds.has(chunk.id);
          return (
            <article
              key={chunk.id}
              className={`knowledge-chunk-card${selected ? " knowledge-chunk-card--selected" : ""}`}
              onClick={(event) => handleChunkClick(chunk, event)}
            >
              <div className="knowledge-chunk-card__head">
                <span className="knowledge-chunk-card__index">
                  {t("knowledge.chunks.blockIndex", { index: (chunk.chunkIndex ?? 0) + 1 })}
                </span>
                <div className="knowledge-chunk-card__head-right">
                  <span className="knowledge-chunk-card__chars">
                    {t("knowledge.chunks.charCount", { count: chunk.content.length })}
                  </span>
                  <button
                    type="button"
                    className="knowledge-chunk-card__delete"
                    title={t("knowledge.chunks.delete")}
                    aria-label={t("knowledge.chunks.delete")}
                    disabled={deleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDeleteChunks([chunk.id]);
                    }}
                  >
                    <ChunkDeleteIcon />
                  </button>
                </div>
              </div>
              <pre className="knowledge-chunk-card__body">{chunk.content}</pre>
            </article>
          );
        })}
      </div>

      <KnowledgeChunksPagination
        page={page}
        total={total}
        pageSize={KNOWLEDGE_CHUNK_PAGE_SIZE}
        onPageChange={handlePageChange}
      />

      <KnowledgeRecallTestSubWindow
        open={recallOpen}
        entryId={entry.id}
        entryTitle={entry.title}
        onClose={() => setRecallOpen(false)}
      />
    </div>
  );
}

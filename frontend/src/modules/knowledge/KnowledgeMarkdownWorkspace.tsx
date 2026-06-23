import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KnowledgeEmbeddingModelSelect,
  useKnowledgeEmbeddingModelSelectionId,
} from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { Button } from "../../components/ui/Button";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { KnowledgeCrepeEditor } from "./KnowledgeCrepeEditor";
import { isKnowledgeFolder } from "./knowledgeTree";
import { loadKnowledgeVectorStatus, vectorizeKnowledgeEntry } from "./knowledgeVectorize";

const AUTOSAVE_MS = 800;

export function KnowledgeMarkdownWorkspace() {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const selectedEntryId = useKnowledgeStore((s) => s.selectedEntryId);
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);
  const createDocument = useKnowledgeStore((s) => s.createDocument);
  const providers = useAiModelsStore((s) => s.providers);
  const knowledgeChunkSize = useSettingsStore((s) => s.knowledgeChunkSize);
  const knowledgeChunkOverlap = useSettingsStore((s) => s.knowledgeChunkOverlap);
  const modelSelectionId = useKnowledgeEmbeddingModelSelectionId();

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vectorStatus, setVectorStatus] = useState<{
    chunkCount: number;
    embeddedAt: number;
  } | null>(null);
  const [vectorizing, setVectorizing] = useState(false);
  const [vectorMessage, setVectorMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const entry = useMemo(
    () => (selectedEntryId ? entries.find((e) => e.id === selectedEntryId) ?? null : null),
    [entries, selectedEntryId],
  );
  const isFolder = entry ? isKnowledgeFolder(entry) : false;

  const [draftContent, setDraftContent] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);

  useEffect(() => {
    setDraftContent(null);
    setDraftTitle(null);
    setVectorMessage(null);
  }, [entry?.id]);

  useEffect(() => {
    if (!entry || isKnowledgeFolder(entry)) {
      setVectorStatus(null);
      return;
    }
    let cancelled = false;
    void loadKnowledgeVectorStatus(entry.id)
      .then((status) => {
        if (cancelled) return;
        if (status?.chunkCount != null && status.embeddedAt != null) {
          setVectorStatus({ chunkCount: status.chunkCount, embeddedAt: status.embeddedAt });
        } else {
          setVectorStatus(null);
        }
      })
      .catch(() => {
        if (!cancelled) setVectorStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entry, isFolder]);

  const displayTitle = draftTitle ?? entry?.title ?? "";
  const displayContent = draftContent ?? entry?.content ?? "";

  const titleRef = useRef("");
  titleRef.current = displayTitle;

  const contentRef = useRef("");
  contentRef.current = draftContent ?? entry?.content ?? "";

  const scheduleSave = useCallback(
    (nextTitle: string, nextContent: string) => {
      if (!entry || isFolder) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void saveEntry({
          ...entry,
          title: nextTitle,
          content: nextContent,
        });
      }, AUTOSAVE_MS);
    },
    [entry, isFolder, saveEntry],
  );

  const flushSave = useCallback(async () => {
    if (!entry || isFolder) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveEntry({
      ...entry,
      title: titleRef.current,
      content: contentRef.current,
    });
  }, [entry, isFolder, saveEntry]);

  const handleVectorize = useCallback(async () => {
    if (!entry || isFolder || vectorizing) return;
    if (!modelSelectionId) {
      setVectorMessage({ kind: "err", text: t("knowledge.vectorize.noModel") });
      return;
    }
    setVectorizing(true);
    setVectorMessage(null);
    try {
      await flushSave();
      const result = await vectorizeKnowledgeEntry(
        entry.id,
        modelSelectionId,
        providers,
        { knowledgeChunkSize, knowledgeChunkOverlap },
      );
      if (result.ok) {
        setVectorStatus({
          chunkCount: result.chunkCount,
          embeddedAt: Date.now(),
        });
        setVectorMessage({
          kind: "ok",
          text: t("knowledge.vectorize.success", { count: result.chunkCount }),
        });
      } else {
        setVectorMessage({ kind: "err", text: result.error });
      }
    } catch (e) {
      setVectorMessage({ kind: "err", text: String(e) });
    } finally {
      setVectorizing(false);
    }
  }, [
    entry,
    flushSave,
    isFolder,
    knowledgeChunkOverlap,
    knowledgeChunkSize,
    modelSelectionId,
    providers,
    t,
    vectorizing,
  ]);

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (!entry || isFolder) return;
      setDraftContent(markdown);
      scheduleSave(titleRef.current, markdown);
    },
    [entry, isFolder, scheduleSave],
  );

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  if (!entry) {
    return (
      <div className="knowledge-workspace knowledge-workspace--empty">
        <WorkspaceEmptyPage
          prompt={t("knowledge.selectEntry")}
          actions={
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void createDocument()}
            >
              {t("knowledge.tree.newDocument")}
            </Button>
          }
        />
      </div>
    );
  }

  if (isFolder) {
    return (
      <div className="knowledge-workspace knowledge-workspace--folder">
        <div className="knowledge-workspace-header">
          <input
            className="knowledge-workspace-title"
            value={displayTitle}
            onChange={(e) => {
              setDraftTitle(e.target.value);
              void renameEntry(entry.id, e.target.value);
            }}
            aria-label={t("knowledge.title")}
          />
        </div>
        <ModuleEmptyState preset="folder" title={t("knowledge.tree.folderHint")} />
      </div>
    );
  }

  const vectorStatusLabel =
    vectorStatus != null
      ? t("knowledge.vectorize.statusEmbedded", { count: vectorStatus.chunkCount })
      : t("knowledge.vectorize.statusNone");

  return (
    <div className="knowledge-workspace">
      <div className="knowledge-workspace-header">
        <input
          className="knowledge-workspace-title"
          value={displayTitle}
          onChange={(e) => {
            const next = e.target.value;
            setDraftTitle(next);
            scheduleSave(next, contentRef.current);
          }}
          aria-label={t("knowledge.title")}
        />
        <div className="knowledge-workspace-header-actions">
          <KnowledgeEmbeddingModelSelect disabled={vectorizing} />
          <span
            className={`knowledge-vector-status ${vectorStatus ? "knowledge-vector-status--ok" : ""}`}
            title={vectorStatusLabel}
          >
            {vectorStatusLabel}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={vectorizing || !modelSelectionId}
            onClick={() => void handleVectorize()}
          >
            {vectorizing ? t("knowledge.vectorize.parsing") : t("knowledge.vectorize.parse")}
          </Button>
        </div>
      </div>
      {vectorMessage && (
        <div
          className={`knowledge-vector-message knowledge-vector-message--${vectorMessage.kind}`}
          role="status"
        >
          {vectorMessage.text}
        </div>
      )}
      <KnowledgeCrepeEditor
        key={entry.id}
        entryId={entry.id}
        defaultContent={displayContent}
        placeholder={t("knowledge.contentPlaceholder")}
        onChange={handleContentChange}
      />
    </div>
  );
}

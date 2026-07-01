import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { TextInput } from "../../components/ui/TextInput";
import { useI18n } from "../../i18n";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { KnowledgeCrepeEditor } from "./KnowledgeCrepeEditor";
import { parseKnowledgeImportPdfPath } from "./knowledgeImport";
import { KnowledgePdfPreview } from "./KnowledgePdfPreview";
import { isKnowledgeFolder, isKnowledgeImported } from "./knowledgeTree";
import { loadKnowledgeVectorStatus, KNOWLEDGE_VECTORIZED_EVENT } from "./knowledgeVectorize";

const AUTOSAVE_MS = 800;

interface KnowledgeDocumentPanelProps {
  entryId: string;
}

export function KnowledgeDocumentPanel({ entryId }: KnowledgeDocumentPanelProps) {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vectorStatus, setVectorStatus] = useState<{
    chunkCount: number;
    embeddedAt: number;
  } | null>(null);

  const entry = useMemo(
    () => entries.find((item) => item.id === entryId) ?? null,
    [entries, entryId],
  );
  const isFolder = entry ? isKnowledgeFolder(entry) : false;
  const isImported = entry ? isKnowledgeImported(entry) : false;
  const pdfPath = entry && isImported ? parseKnowledgeImportPdfPath(entry.source) : null;

  const [draftContent, setDraftContent] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);

  useEffect(() => {
    setDraftContent(null);
    setDraftTitle(null);
  }, [entry?.id]);

  useEffect(() => {
    if (!entry || isFolder || isImported) {
      setVectorStatus(null);
      return;
    }
    let cancelled = false;
    const loadStatus = () => {
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
    };
    loadStatus();
    const onVectorized = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId: string }>).detail;
      if (detail?.entryId === entry.id) {
        loadStatus();
      }
    };
    window.addEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    return () => {
      cancelled = true;
      window.removeEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    };
  }, [entry, isFolder, isImported]);

  const displayTitle = draftTitle ?? entry?.title ?? "";
  const displayContent = draftContent ?? entry?.content ?? "";

  const titleRef = useRef("");
  titleRef.current = displayTitle;

  const contentRef = useRef("");
  contentRef.current = draftContent ?? entry?.content ?? "";

  const scheduleSave = useCallback(
    (nextTitle: string, nextContent: string) => {
      if (!entry || isFolder || isImported) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void saveEntry({
          ...entry,
          title: nextTitle,
          content: nextContent,
        });
      }, AUTOSAVE_MS);
    },
    [entry, isFolder, isImported, saveEntry],
  );

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (!entry || isFolder || isImported) return;
      setDraftContent(markdown);
      scheduleSave(titleRef.current, markdown);
    },
    [entry, isFolder, isImported, scheduleSave],
  );

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  if (!entry) {
    return (
      <div className="knowledge-workspace knowledge-workspace--missing">
        <ModuleEmptyState preset="folder" title={t("knowledge.noEntries")} />
      </div>
    );
  }

  if (isFolder) {
    return (
      <div className="knowledge-workspace knowledge-workspace--folder">
        <div className="knowledge-workspace-header">
          <TextInput
            className="knowledge-workspace-title"
            value={displayTitle}
            onChange={(value) => {
              setDraftTitle(value);
              void renameEntry(entry.id, value);
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

  if (isImported) {
    return (
      <div className="knowledge-workspace knowledge-workspace--imported">
        <div className="knowledge-workspace-header">
          <h2 className="knowledge-workspace-title knowledge-workspace-title--readonly">{displayTitle}</h2>
          <div className="knowledge-workspace-header-actions">
            <span className="knowledge-import-badge">{t("knowledge.importPreview.importedBadge")}</span>
          </div>
        </div>
        {pdfPath ? (
          <KnowledgePdfPreview pdfPath={pdfPath} title={displayTitle} />
        ) : (
          <ModuleEmptyState preset="folder" title={t("knowledge.importPreview.pdfMissing")} />
        )}
      </div>
    );
  }

  return (
    <div className="knowledge-workspace">
      <div className="knowledge-workspace-header">
        <TextInput
          className="knowledge-workspace-title"
          value={displayTitle}
          onChange={(value) => {
            setDraftTitle(value);
            scheduleSave(value, contentRef.current);
          }}
          aria-label={t("knowledge.title")}
        />
        <div className="knowledge-workspace-header-actions">
          <span
            className={`knowledge-vector-status ${vectorStatus ? "knowledge-vector-status--ok" : ""}`}
            title={vectorStatusLabel}
          >
            {vectorStatusLabel}
          </span>
        </div>
      </div>
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

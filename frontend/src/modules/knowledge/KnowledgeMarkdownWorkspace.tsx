import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { KnowledgeCrepeEditor } from "./KnowledgeCrepeEditor";
import { isKnowledgeFolder } from "./knowledgeTree";

const AUTOSAVE_MS = 800;

export function KnowledgeMarkdownWorkspace() {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const selectedEntryId = useKnowledgeStore((s) => s.selectedEntryId);
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);
  const createDocument = useKnowledgeStore((s) => s.createDocument);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [entry?.id]);

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

import { useCallback, useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { useI18n } from "../../i18n";
import { getEntryOrDraft, useKnowledgeStore } from "../../stores/knowledgeStore";
import { isKnowledgeFolder } from "./knowledgeTree";

const AUTOSAVE_MS = 800;

export function KnowledgeMarkdownWorkspace() {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const selectedEntryId = useKnowledgeStore((s) => s.selectedEntryId);
  const draftById = useKnowledgeStore((s) => s.draftById);
  const updateDraft = useKnowledgeStore((s) => s.updateDraft);
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const entry = useMemo(
    () => getEntryOrDraft(entries, draftById, selectedEntryId),
    [draftById, entries, selectedEntryId],
  );

  const isFolder = entry ? isKnowledgeFolder(entry) : false;
  const title = entry?.title ?? "";
  const content = entry?.content ?? "";

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

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  if (!entry) {
    return (
      <div className="knowledge-workspace knowledge-workspace--empty">
        <ModuleEmptyState preset="document" title={t("knowledge.selectEntry")} />
      </div>
    );
  }

  if (isFolder) {
    return (
      <div className="knowledge-workspace knowledge-workspace--folder">
        <div className="knowledge-workspace-header">
          <input
            className="knowledge-workspace-title"
            value={title}
            onChange={(e) => {
              updateDraft(entry.id, { title: e.target.value });
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
          value={title}
          onChange={(e) => {
            const next = e.target.value;
            updateDraft(entry.id, { title: next, content });
            scheduleSave(next, content);
          }}
          aria-label={t("knowledge.title")}
        />
      </div>
      <DockLayout direction="horizontal" className="knowledge-editor-split">
        <DockPanel defaultSize="50%" minSize="25%" className="knowledge-editor-pane">
          <textarea
            className="knowledge-markdown-input"
            value={content}
            onChange={(e) => {
              const next = e.target.value;
              updateDraft(entry.id, { title, content: next });
              scheduleSave(title, next);
            }}
            placeholder={t("knowledge.contentPlaceholder")}
            spellCheck={false}
          />
        </DockPanel>
        <DockHandle direction="horizontal" />
        <DockPanel defaultSize="50%" minSize="25%" className="knowledge-preview-pane">
          <div className="knowledge-markdown-preview knowledge-detail-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content || t("knowledge.previewEmpty")}
            </ReactMarkdown>
          </div>
        </DockPanel>
      </DockLayout>
    </div>
  );
}

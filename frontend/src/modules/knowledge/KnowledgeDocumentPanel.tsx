import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { Button } from "../../components/ui/Button";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import { useKnowledgeEmbeddingProviderConfig } from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useKnowledgeWorkspaceStore } from "../../stores/knowledgeWorkspaceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { KnowledgeCrepeEditor, type KnowledgeLinkNavigate } from "./KnowledgeCrepeEditor";
import { KnowledgeHistoryPanel } from "./KnowledgeHistoryPanel";
import { KnowledgeHoverPreview } from "./KnowledgeHoverPreview";
import { KnowledgeNoteRightRail } from "./KnowledgeNoteRightRail";
import { KnowledgeQuickSwitcher } from "./KnowledgeQuickSwitcher";
import { KnowledgeSourceEditor } from "./KnowledgeSourceEditor";
import { GlobalTagEditor } from "../tags/GlobalTagEditor";
import {
  countKnowledgeChars,
  exportKnowledgeMarkdown,
  exportKnowledgePdf,
} from "./knowledgeExport";
import { parseKnowledgeImportPdfPath } from "./knowledgeImport";
import { KnowledgePdfPreview } from "./KnowledgePdfPreview";
import { parseHeadings } from "./metadata/headings";
import { resolveTitleToId } from "./metadata/KnowledgeMetadataCache";
import { useKnowledgeMetadata } from "./metadata/useKnowledgeMetadata";
import { knowledgeAssetHref } from "./metadata/wikilink";
import { normalizeKnowledgeTags } from "./knowledgeTags";
import {
  createEmptyEntry,
  isKnowledgeFolder,
  isKnowledgeImported,
  normalizeParentId,
  nextSortOrder,
} from "./knowledgeTree";
import {
  isKnowledgeEntryVectorizing,
  loadKnowledgeVectorStatus,
  submitKnowledgeVectorize,
  KNOWLEDGE_VECTORIZED_EVENT,
} from "./knowledgeVectorize";
import { useKnowledgeOpenEntry } from "./useKnowledgeOpenEntry";

const AUTOSAVE_MS = 800;

interface KnowledgeDocumentPanelProps {
  entryId: string;
}

type SaveState = "idle" | "dirty" | "saving" | "saved";

export function KnowledgeDocumentPanel({ entryId }: KnowledgeDocumentPanelProps) {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);
  const createDocument = useKnowledgeStore((s) => s.createDocument);
  const createFolder = useKnowledgeStore((s) => s.createFolder);
  const { openEntry } = useKnowledgeOpenEntry();
  const meta = useKnowledgeMetadata();

  const rightRailCollapsed = useKnowledgeWorkspaceStore((s) => s.rightRailCollapsed);
  const rightRailTab = useKnowledgeWorkspaceStore((s) => s.rightRailTab);
  const setRightRailCollapsed = useKnowledgeWorkspaceStore((s) => s.setRightRailCollapsed);
  const setRightRailTab = useKnowledgeWorkspaceStore((s) => s.setRightRailTab);
  const editorMode = useKnowledgeWorkspaceStore((s) => s.editorMode);
  const setEditorMode = useKnowledgeWorkspaceStore((s) => s.setEditorMode);

  const embeddingProvider = useKnowledgeEmbeddingProviderConfig();
  const knowledgeChunkSize = useSettingsStore((s) => s.knowledgeChunkSize);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const knowledgeChunkOverlap = useSettingsStore((s) => s.knowledgeChunkOverlap);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vectorStatus, setVectorStatus] = useState<{
    chunkCount: number;
    embeddedAt: number;
  } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [exporting, setExporting] = useState<"md" | "pdf" | null>(null);
  const [, setVectorTick] = useState(0);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [jumpHeadingText, setJumpHeadingText] = useState<string | null>(null);
  const [jumpSourceLine, setJumpSourceLine] = useState<number | null>(null);
  const [hoverNav, setHoverNav] = useState<KnowledgeLinkNavigate | null>(null);
  const [wikilinkQuery, setWikilinkQuery] = useState<{ query: string; caret: number } | null>(null);

  const entry = useMemo(
    () => entries.find((item) => item.id === entryId) ?? null,
    [entries, entryId],
  );
  const isFolder = entry ? isKnowledgeFolder(entry) : false;
  const isImported = entry ? isKnowledgeImported(entry) : false;
  const pdfPath = entry && isImported ? parseKnowledgeImportPdfPath(entry.source) : null;

  const children = useMemo(() => {
    if (!entry || !isFolder) return [];
    return entries
      .filter((item) => normalizeParentId(item.parentId) === entry.id)
      .sort((a, b) => {
        const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (order !== 0) return order;
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      });
  }, [entries, entry, isFolder]);

  const [draftContent, setDraftContent] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftTags, setDraftTags] = useState<string[] | null>(null);

  useEffect(() => {
    setDraftContent(null);
    setDraftTitle(null);
    setDraftTags(null);
    setSaveState("idle");
    setHistoryOpen(false);
    setEditorEpoch(0);
  }, [entry?.id]);

  useEffect(() => {
    void unwrapCommand(commands.knowledgeTags())
      .then((tags) => setAllTags(normalizeKnowledgeTags(tags)))
      .catch(() => setAllTags([]));
  }, [entries]);

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
      if (detail?.entryId === entry.id) loadStatus();
    };
    window.addEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    return () => {
      cancelled = true;
      window.removeEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    };
  }, [entry, isFolder, isImported]);

  const displayTitle = draftTitle ?? entry?.title ?? "";
  const displayContent = draftContent ?? entry?.content ?? "";
  const displayTags = draftTags ?? entry?.tags ?? [];
  const charCount = useMemo(() => countKnowledgeChars(displayContent), [displayContent]);
  const headings = useMemo(() => parseHeadings(displayContent), [displayContent]);

  const titleRef = useRef("");
  titleRef.current = displayTitle;
  const contentRef = useRef("");
  contentRef.current = draftContent ?? entry?.content ?? "";
  const tagsRef = useRef<string[]>([]);
  tagsRef.current = displayTags;

  const flushSave = useCallback(
    async (nextTitle: string, nextContent: string, nextTags?: string[]) => {
      if (!entry || isFolder || isImported) return;
      setSaveState("saving");
      const ok = await saveEntry({
        ...entry,
        title: nextTitle,
        content: nextContent,
        tags: nextTags ?? tagsRef.current,
      });
      setSaveState(ok ? "saved" : "dirty");
      if (ok) {
        void unwrapCommand(commands.knowledgeTags())
          .then((tags) => setAllTags(normalizeKnowledgeTags(tags)))
          .catch(() => undefined);
      }
    },
    [entry, isFolder, isImported, saveEntry],
  );

  const scheduleSave = useCallback(
    (nextTitle: string, nextContent: string, nextTags?: string[]) => {
      if (!entry || isFolder || isImported) return;
      setSaveState("dirty");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushSave(nextTitle, nextContent, nextTags);
      }, AUTOSAVE_MS);
    },
    [entry, flushSave, isFolder, isImported],
  );

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (!entry || isFolder || isImported) return;
      setDraftContent(markdown);
      scheduleSave(titleRef.current, markdown);
    },
    [entry, isFolder, isImported, scheduleSave],
  );

  const handleTagsChange = useCallback(
    (tags: string[]) => {
      if (!entry || isFolder || isImported) return;
      setDraftTags(tags);
      scheduleSave(titleRef.current, contentRef.current, tags);
    },
    [entry, isFolder, isImported, scheduleSave],
  );

  const handleExportMd = useCallback(async () => {
    if (!entry || isFolder) return;
    setExporting("md");
    try {
      const path = await exportKnowledgeMarkdown(displayTitle, contentRef.current, {
        dialogTitle: t("knowledge.export.markdown"),
      });
      if (path) {
        publishModuleStatusLog("knowledge", t("knowledge.export.markdownDone", { path }), "info");
      }
    } catch (err) {
      publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
    } finally {
      setExporting(null);
    }
  }, [displayTitle, entry, isFolder, t]);

  const handleExportPdf = useCallback(async () => {
    if (!entry || isFolder) return;
    setExporting("pdf");
    try {
      await exportKnowledgePdf(displayTitle, contentRef.current);
      publishModuleStatusLog("knowledge", t("knowledge.export.pdfStarted"), "info");
    } catch (err) {
      publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
    } finally {
      setExporting(null);
    }
  }, [displayTitle, entry, isFolder, t]);

  const handleVectorize = useCallback(async () => {
    if (!entry || isFolder || isImported) return;
    if (!embeddingProvider) {
      publishModuleStatusLog("knowledge", t("knowledge.vectorize.noModel"), "error");
      return;
    }
    try {
      await submitKnowledgeVectorize(entry.id, embeddingProvider, {
        knowledgeChunkSize,
        knowledgeChunkOverlap,
      });
      setVectorTick((n) => n + 1);
    } catch (err) {
      publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
    }
  }, [
    embeddingProvider,
    entry,
    isFolder,
    isImported,
    knowledgeChunkOverlap,
    knowledgeChunkSize,
    t,
  ]);

  const handleInsertImage = useCallback(async () => {
    if (!entry || isFolder || isImported) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const bytes = await readFile(selected);
      const fileName = selected.split(/[/\\]/).pop() || "image.png";
      const saved = await unwrapCommand(
        commands.knowledgeSaveAsset(entry.id, fileName, Array.from(bytes)),
      );
      const md = `\n![${fileName}](${knowledgeAssetHref(saved.entryId, saved.fileName)})\n`;
      const next = `${contentRef.current}${md}`;
      setDraftContent(next);
      scheduleSave(titleRef.current, next);
    } catch (err) {
      publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
    }
  }, [entry, isFolder, isImported, scheduleSave]);

  const handleNavigateLink = useCallback(
    async (nav: KnowledgeLinkNavigate) => {
      setHoverNav(null);
      if (nav.entryId) {
        openEntry(nav.entryId, nav.openMode);
        return;
      }
      if (nav.missingTitle) {
        const parent = entry ? normalizeParentId(entry.parentId) : "";
        const newEntry = createEmptyEntry({
          title: nav.missingTitle,
          nodeType: "document",
          parentId: parent,
          sortOrder: nextSortOrder(entries, parent),
        });
        const ok = await saveEntry(newEntry);
        if (ok) openEntry(newEntry.id, "permanent");
      }
    },
    [entries, entry, openEntry, saveEntry],
  );

  const handleCreateFromSwitcher = useCallback(
    async (title: string) => {
      const parent = entry ? normalizeParentId(entry.parentId) : "";
      const newEntry = createEmptyEntry({
        title,
        nodeType: "document",
        parentId: parent,
        sortOrder: nextSortOrder(entries, parent),
      });
      const ok = await saveEntry(newEntry);
      if (ok) openEntry(newEntry.id, "permanent");
    },
    [entries, entry, openEntry, saveEntry],
  );

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (isMod && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const vectorStatusLabel =
    vectorStatus != null
      ? t("knowledge.vectorize.statusEmbedded", { count: vectorStatus.chunkCount })
      : t("knowledge.vectorize.statusNone");

  const vectorizing = entry ? isKnowledgeEntryVectorizing(entry.id) : false;

  const moreMenuItems = useMemo((): ContextMenuItem[] => {
    const vectorLabel = vectorizing
      ? t("knowledge.vectorize.parsing", { title: displayTitle })
      : vectorStatus
        ? t("knowledge.vectorize.reparse")
        : t("knowledge.vectorize.parse");
    return [
      {
        id: "export-md",
        label: t("knowledge.export.markdown"),
        disabled: exporting !== null,
        onClick: () => void handleExportMd(),
      },
      {
        id: "export-pdf",
        label: t("knowledge.export.pdf"),
        disabled: exporting !== null,
        onClick: () => void handleExportPdf(),
      },
      {
        id: "insert-image",
        label: t("knowledge.assets.insertImage"),
        onClick: () => void handleInsertImage(),
      },
      { id: "sep-vectorize", separator: true, label: "" },
      {
        id: "vectorize",
        label: vectorLabel,
        shortcut: vectorStatusLabel,
        disabled: !embeddingProvider || vectorizing,
        onClick: () => void handleVectorize(),
      },
      { id: "sep-save", separator: true, label: "" },
      {
        id: "save",
        label: t("knowledge.save"),
        disabled: saveState !== "dirty",
        onClick: () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          void flushSave(titleRef.current, contentRef.current);
        },
      },
    ];
  }, [
    displayTitle,
    embeddingProvider,
    exporting,
    flushSave,
    handleExportMd,
    handleExportPdf,
    handleInsertImage,
    handleVectorize,
    saveState,
    t,
    vectorStatus,
    vectorStatusLabel,
    vectorizing,
  ]);

  const hoverPreview = useMemo(() => {
    if (!hoverNav) return null;
    if (hoverNav.entryId) {
      const target = entries.find((item) => item.id === hoverNav.entryId);
      return {
        title: target?.title ?? "",
        preview: (target?.content ?? "").slice(0, 280),
        missing: false,
      };
    }
    return {
      title: hoverNav.missingTitle ?? "",
      preview: "",
      missing: true,
    };
  }, [entries, hoverNav]);

  const wikilinkSuggestions = useMemo(() => {
    if (!wikilinkQuery || wikilinkQuery.caret < 0) return [];
    const q = wikilinkQuery.query.toLowerCase();
    return entries
      .filter((item) => !isKnowledgeFolder(item))
      .filter((item) => !q || item.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [entries, wikilinkQuery]);

  if (!entry) {
    return (
      <div className="knowledge-workspace knowledge-workspace--missing">
        <ModuleEmptyState preset="folder" title={t("knowledge.noEntries")} />
      </div>
    );
  }

  const saveLabel =
    saveState === "saving"
      ? t("knowledge.doc.saving")
      : saveState === "saved"
        ? t("knowledge.doc.saved")
        : saveState === "dirty"
          ? t("knowledge.doc.unsaved")
          : "";

  if (isFolder) {
    return (
      <div className="knowledge-workspace knowledge-workspace--folder knowledge-workspace--note">
        <div className="knowledge-note-chrome">
          <div className="knowledge-note-chrome__left">
            <span className="knowledge-note-meta">
              {t("knowledge.folder.childCount", { count: children.length })}
            </span>
          </div>
          <div className="knowledge-note-chrome__right">
            <Button size="sm" variant="ghost" onClick={() => void createFolder(entry.id)}>
              {t("knowledge.tree.newFolder")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void createDocument(entry.id).then((id) => {
                  if (id) openEntry(id, "permanent");
                });
              }}
            >
              {t("knowledge.tree.newDocument")}
            </Button>
          </div>
        </div>
        <div className="knowledge-note-scroll">
          <TextInput
            className="knowledge-note-title"
            value={displayTitle}
            onChange={(value) => {
              setDraftTitle(value);
              void renameEntry(entry.id, value);
            }}
            aria-label={t("knowledge.title")}
          />
          {children.length === 0 ? (
            <ModuleEmptyState preset="folder" title={t("knowledge.tree.folderHint")} />
          ) : (
            <div className="knowledge-folder-browser">
              <ul className="knowledge-folder-list">
                {children.map((child) => {
                  const childIsFolder = isKnowledgeFolder(child);
                  return (
                    <li key={child.id}>
                      <button
                        type="button"
                        className="knowledge-folder-item"
                        onClick={() => openEntry(child.id, "preview")}
                        onDoubleClick={() => openEntry(child.id, "permanent")}
                      >
                        <span className="knowledge-folder-item__title">{child.title}</span>
                        <span className="knowledge-folder-item__meta">
                          {childIsFolder
                            ? t("knowledge.folder.kindFolder")
                            : isKnowledgeImported(child)
                              ? t("knowledge.importPreview.importedBadge")
                              : t("knowledge.folder.kindDocument")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isImported) {
    return (
      <div className="knowledge-workspace knowledge-workspace--imported knowledge-workspace--note">
        <div className="knowledge-note-chrome">
          <div className="knowledge-note-chrome__left">
            <span className="knowledge-note-chip">{t("knowledge.importPreview.importedBadge")}</span>
          </div>
        </div>
        <div className="knowledge-note-scroll knowledge-note-scroll--pdf">
          <h1 className="knowledge-note-title knowledge-note-title--readonly">{displayTitle}</h1>
          {pdfPath ? (
            <KnowledgePdfPreview pdfPath={pdfPath} title={displayTitle} />
          ) : (
            <ModuleEmptyState preset="folder" title={t("knowledge.importPreview.pdfMissing")} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="knowledge-workspace knowledge-workspace--note knowledge-workspace--split">
      <div className="knowledge-note-main">
        <div className="knowledge-note-chrome">
          <div className="knowledge-note-chrome__spacer" />
          <div className="knowledge-note-chrome__right">
            {(saveLabel || charCount > 0) && (
              <span
                className={`knowledge-note-meta${
                  saveState === "dirty" || saveState === "saving"
                    ? ` knowledge-note-meta--${saveState}`
                    : ""
                }`}
                title={[saveLabel, t("knowledge.doc.charCount", { count: charCount }), vectorStatusLabel]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {saveState === "dirty" ? <span className="knowledge-note-dot" aria-hidden /> : null}
                {saveLabel || t("knowledge.doc.charCount", { count: charCount })}
              </span>
            )}
            <Button
              type="button"
              variant="icon"
              size="icon-sm"
              title={
                rightRailCollapsed ? t("knowledge.rail.expand") : t("knowledge.rail.collapse")
              }
              aria-label={
                rightRailCollapsed ? t("knowledge.rail.expand") : t("knowledge.rail.collapse")
              }
              aria-pressed={!rightRailCollapsed}
              className={!rightRailCollapsed ? "is-active" : undefined}
              onClick={() => setRightRailCollapsed(!rightRailCollapsed)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                <path d="M10 2.5v11" />
              </svg>
            </Button>
            <Button
              type="button"
              variant="icon"
              size="icon-sm"
              title={t("knowledge.editorMode.source")}
              aria-pressed={editorMode === "source"}
              className={editorMode === "source" ? "is-active" : undefined}
              onClick={() => {
                const next = editorMode === "source" ? "wysiwyg" : "source";
                if (next === "wysiwyg") setEditorEpoch((value) => value + 1);
                setEditorMode(next);
              }}
            >
              {"</>"}
            </Button>
            <Button
              type="button"
              variant="icon"
              size="icon-sm"
              title={t("knowledge.history.title")}
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((value) => !value)}
            >
              ⏱
            </Button>
            <Button
              type="button"
              variant="icon"
              size="icon-sm"
              className="knowledge-note-more"
              title={t("knowledge.doc.moreActions")}
              aria-label={t("knowledge.doc.moreActions")}
              aria-haspopup="menu"
              aria-expanded={moreMenu != null}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMoreMenu({ x: Math.max(8, rect.right - 180), y: rect.bottom + 4 });
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
                <circle cx="3.5" cy="8" r="1.25" />
                <circle cx="8" cy="8" r="1.25" />
                <circle cx="12.5" cy="8" r="1.25" />
              </svg>
            </Button>
          </div>
        </div>

        <div className="knowledge-note-scroll">
          <TextInput
            className="knowledge-note-title"
            value={displayTitle}
            onChange={(value) => {
              setDraftTitle(value);
              scheduleSave(value, contentRef.current);
            }}
            aria-label={t("knowledge.title")}
            placeholder={t("knowledge.title")}
          />
          <GlobalTagEditor
            kind="knowledge"
            resourceId={entry.id}
            tags={displayTags}
            suggestions={allTags}
            onChange={handleTagsChange}
          />
          {editorMode === "source" ? (
            <div className="knowledge-source-wrap">
              <KnowledgeSourceEditor
                value={displayContent}
                placeholder={t("knowledge.contentPlaceholder")}
                onChange={handleContentChange}
                jumpToLine={jumpSourceLine}
                onJumpHandled={() => setJumpSourceLine(null)}
                onRequestWikilinkComplete={(query, caret) => {
                  if (caret < 0) setWikilinkQuery(null);
                  else setWikilinkQuery({ query, caret });
                }}
              />
              {wikilinkSuggestions.length > 0 && wikilinkQuery ? (
                <ul className="knowledge-wikilink-suggest">
                  {wikilinkSuggestions.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          const content = contentRef.current;
                          const caret = wikilinkQuery.caret;
                          const before = content.slice(0, caret);
                          const open = before.lastIndexOf("[[");
                          if (open < 0) return;
                          const after = content.slice(caret);
                          const closeIdx = after.indexOf("]]");
                          const rest = closeIdx >= 0 ? after.slice(closeIdx + 2) : after;
                          const next = `${content.slice(0, open)}[[${item.title}]]${rest}`;
                          setDraftContent(next);
                          scheduleSave(titleRef.current, next);
                          setWikilinkQuery(null);
                        }}
                      >
                        {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <KnowledgeCrepeEditor
              key={`${entry.id}-${editorEpoch}`}
              entryId={entry.id}
              defaultContent={displayContent}
              placeholder={t("knowledge.contentPlaceholder")}
              resolveTitleToId={(title) => resolveTitleToId(meta, title)}
              idToTitle={(id) => meta.idToTitle.get(id) ?? null}
              onChange={handleContentChange}
              onNavigateLink={(nav) => void handleNavigateLink(nav)}
              onHoverLink={setHoverNav}
              jumpHeadingText={jumpHeadingText}
              onJumpHeadingHandled={() => setJumpHeadingText(null)}
            />
          )}
          {historyOpen ? (
            <KnowledgeHistoryPanel
              entryId={entry.id}
              currentTitle={displayTitle}
              currentContent={displayContent}
              open={historyOpen}
              onClose={() => setHistoryOpen(false)}
              onRestore={(title, content) => {
                setDraftTitle(title);
                setDraftContent(content);
                setEditorEpoch((value) => value + 1);
                void flushSave(title, content);
              }}
            />
          ) : null}
        </div>
      </div>

      {!rightRailCollapsed ? (
        <KnowledgeNoteRightRail
          tab={rightRailTab}
          onTabChange={setRightRailTab}
          onCollapse={() => setRightRailCollapsed(true)}
          headings={headings}
          onJumpHeading={(heading) => {
            if (editorMode === "source") setJumpSourceLine(heading.line);
            else setJumpHeadingText(heading.text);
          }}
          linked={meta.backlinks.get(entry.id) ?? []}
          unlinked={meta.unlinkedMentions.get(entry.id) ?? []}
          onOpenEntry={(id) => openEntry(id, "preview")}
          entryId={entry.id}
          entryTitle={displayTitle}
          meta={meta}
        />
      ) : null}

      {moreMenu ? (
        <ContextMenu
          items={moreMenuItems}
          position={moreMenu}
          onClose={() => setMoreMenu(null)}
          className="context-menu--wide"
        />
      ) : null}

      {hoverPreview && hoverNav ? (
        <KnowledgeHoverPreview
          x={hoverNav.clientX}
          y={hoverNav.clientY}
          title={hoverPreview.title}
          preview={hoverPreview.preview}
          missing={hoverPreview.missing}
          onOpen={() => void handleNavigateLink(hoverNav)}
          onClose={() => setHoverNav(null)}
        />
      ) : null}

      <KnowledgeQuickSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        onOpen={(id) => openEntry(id, "permanent")}
        onCreate={(title) => void handleCreateFromSwitcher(title)}
      />
    </div>
  );
}

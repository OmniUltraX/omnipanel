import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ContentPreviewTextModeToolbar,
  type ContentPreviewTextMode,
} from "../../components/ui/content/ContentPreviewView";
import { useTextEditorSubWindowActions } from "../../components/textEditor/useTextEditorSubWindowActions";
import { isPreviewWebUrl, normalizePreviewWebUrl } from "../../lib/contentPreview";
import { SubWindow } from "../../components/ui/window/SubWindow";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { FileEntry } from "../../ipc/bindings";
import {
  FilePreviewContent,
  type FileJsonViewMode,
  type FilePreviewContentHandle,
  type FileTextPreviewMeta,
} from "./FilePreviewContent";
import { FilePreviewTreeSidebar } from "./FilePreviewTreeSidebar";
import type { FilePreviewTreeSession } from "./filePreviewTreeIo";
import { IconDownload } from "./FilesPanelIcons";
import { formatFileSize, LOCAL_CONNECTION_ID } from "./utils";
import { cn } from "../../lib/utils";

const TREE_PREFS_KEY = "omnipanel.filePreview.treePrefs";
const DEFAULT_TREE_WIDTH = 240;

type TreePrefs = { collapsed: boolean; width: number };

function loadTreePrefs(): TreePrefs {
  try {
    const raw = localStorage.getItem(TREE_PREFS_KEY);
    if (!raw) return { collapsed: false, width: DEFAULT_TREE_WIDTH };
    const parsed = JSON.parse(raw) as Partial<TreePrefs>;
    const width =
      typeof parsed.width === "number" && Number.isFinite(parsed.width)
        ? Math.min(420, Math.max(180, parsed.width))
        : DEFAULT_TREE_WIDTH;
    return { collapsed: Boolean(parsed.collapsed), width };
  } catch {
    return { collapsed: false, width: DEFAULT_TREE_WIDTH };
  }
}

function saveTreePrefs(prefs: TreePrefs): void {
  try {
    localStorage.setItem(TREE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota */
  }
}

export interface FilePreviewSubWindowProps {
  open: boolean;
  entry: FileEntry | null;
  connectionId: string;
  onClose: () => void;
  onDownload?: (entry: FileEntry) => void;
  onSaved?: (entry: FileEntry) => void;
  /** 自定义 IO 适配器（终端场景用，绕开 file_manager.connectionId） */
  customIO?: import("./FilePreviewContent").FilePreviewIO;
  /**
   * SSH 资源 id（文件管理 SFTP 关联的 sshConnectionId，或 SSH 会话 id）。
   * 用于 >10MB 文本/JSON 分流到 LargeLogViewer。
   */
  sshResourceId?: string;
  /** 显示左侧目录树；默认 true（所有入口统一） */
  showFileTree?: boolean;
  /** 目录树会话（本地 / SSH）；缺省按 connectionId 推断 */
  treeSession?: FilePreviewTreeSession;
  /** 在目录树中点选文件时回调（由调用方切换 entry） */
  onSelectEntry?: (entry: FileEntry) => void;
}

export function FilePreviewSubWindow({
  open,
  entry,
  connectionId,
  onClose,
  onDownload,
  onSaved,
  customIO,
  sshResourceId,
  showFileTree = true,
  treeSession,
  onSelectEntry,
}: FilePreviewSubWindowProps) {
  const { t } = useI18n();
  const contentRef = useRef<FilePreviewContentHandle>(null);
  const [textMode, setTextMode] = useState<ContentPreviewTextMode>("code");
  const [jsonViewMode, setJsonViewMode] = useState<FileJsonViewMode>("structured");
  const [textPreviewMeta, setTextPreviewMeta] = useState<FileTextPreviewMeta | null>(null);
  const initialPrefs = useMemo(() => loadTreePrefs(), []);
  const [treeCollapsed, setTreeCollapsed] = useState(initialPrefs.collapsed);
  const [treeWidth, setTreeWidth] = useState(initialPrefs.width);

  const { dirty, setDirty, saving, saveNotice, handleSave } = useTextEditorSubWindowActions(
    contentRef,
    {
      open,
      onSaved: entry ? () => onSaved?.(entry) : undefined,
    },
  );

  useEffect(() => {
    setTextMode("code");
    setJsonViewMode("structured");
    setTextPreviewMeta(null);
    setDirty(false);
  }, [entry?.path, setDirty]);

  useEffect(() => {
    saveTreePrefs({ collapsed: treeCollapsed, width: treeWidth });
  }, [treeCollapsed, treeWidth]);

  const resolvedTreeSession = useMemo((): FilePreviewTreeSession => {
    if (treeSession) {
      return {
        sessionType: treeSession.sessionType,
        connectionId: treeSession.connectionId,
        resourceId: treeSession.resourceId ?? sshResourceId ?? null,
        viaFileManager: treeSession.viaFileManager,
      };
    }
    const isLocal = connectionId === LOCAL_CONNECTION_ID;
    return {
      sessionType: isLocal ? "local" : "remote",
      connectionId,
      resourceId: sshResourceId ?? null,
      viaFileManager: !isLocal && !sshResourceId,
    };
  }, [
    connectionId,
    sshResourceId,
    treeSession?.sessionType,
    treeSession?.connectionId,
    treeSession?.resourceId,
    treeSession?.viaFileManager,
  ]);

  const handleTreeSelect = useCallback(
    async (next: FileEntry) => {
      if (!entry || next.path === entry.path) return;
      // 以编辑器真实 dirty 为准，避免 CRLF 规范化等误报导致切换弹窗
      const reallyDirty = contentRef.current?.canSave() ?? dirty;
      if (reallyDirty) {
        const ok = await appConfirm(t("files.preview.unsavedConfirm"));
        if (!ok) return;
      }
      setDirty(false);
      onSelectEntry?.(next);
    },
    [dirty, entry, onSelectEntry, setDirty, t],
  );

  const webPreviewUrl =
    textPreviewMeta && isPreviewWebUrl(textPreviewMeta.text)
      ? normalizePreviewWebUrl(textPreviewMeta.text)
      : null;

  const canSave = dirty && !saving && entry?.kind === "file";

  const title = entry ? (
    <h2 id="subwindow-title" className="subwindow-title file-preview-subwindow-title">
      <span className="file-preview-subwindow-name">
        {entry.name}
        {dirty ? <span className="file-preview-subwindow-dirty">*</span> : null}
      </span>
      {entry.size != null ? (
        <span className="file-preview-subwindow-meta">{formatFileSize(entry.size)}</span>
      ) : null}
      {saveNotice ? (
        <span className="file-preview-subwindow-save-notice">{saveNotice}</span>
      ) : null}
    </h2>
  ) : (
    t("files.preview.title")
  );

  const headerExtra =
    textPreviewMeta || canSave || (entry && onDownload) ? (
      <div className="file-preview-subwindow-header-actions">
        {textPreviewMeta?.jsonStructured ? (
          <div
            className="content-preview-text-toolbar"
            role="group"
            aria-label={t("contentPreview.textMode")}
          >
            <button
              type="button"
              className={cn(
                "content-preview-text-mode-btn",
                jsonViewMode === "structured" && "is-active",
              )}
              aria-pressed={jsonViewMode === "structured"}
              onClick={() => setJsonViewMode("structured")}
            >
              {t("contentPreview.modeJson")}
            </button>
            <button
              type="button"
              className={cn(
                "content-preview-text-mode-btn",
                jsonViewMode === "source" && "is-active",
              )}
              aria-pressed={jsonViewMode === "source"}
              onClick={() => setJsonViewMode("source")}
            >
              {t("contentPreview.modeCode")}
            </button>
          </div>
        ) : textPreviewMeta ? (
          <ContentPreviewTextModeToolbar
            mode={textMode}
            onModeChange={setTextMode}
            showCodeMode={Boolean(textPreviewMeta.codeLanguage)}
            showWebMode={webPreviewUrl != null}
          />
        ) : null}
        {canSave ? (
          <button
            type="button"
            className="file-preview-subwindow-save"
            onClick={() => void handleSave()}
            title={t("files.preview.saveShortcut")}
          >
            {saving ? t("files.preview.saving") : t("files.preview.save")}
          </button>
        ) : null}
        {entry && onDownload ? (
          <button
            type="button"
            className="fm-action-btn"
            onClick={() => onDownload(entry)}
            title={t("files.actions.download")}
            aria-label={t("files.actions.download")}
          >
            <IconDownload />
          </button>
        ) : null}
      </div>
    ) : null;

  const treeEnabled = showFileTree && Boolean(onSelectEntry);

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      className={cn("file-preview-subwindow", treeEnabled && "has-file-tree")}
      widthRatio={treeEnabled ? 0.88 : 0.82}
      heightRatio={0.78}
      headerExtra={headerExtra}
    >
      {entry ? (
        <div className="file-preview-subwindow-layout">
          {treeEnabled ? (
            <FilePreviewTreeSidebar
              session={resolvedTreeSession}
              selectedPath={entry.path}
              onSelectFile={(next) => void handleTreeSelect(next)}
              collapsed={treeCollapsed}
              onCollapsedChange={setTreeCollapsed}
              width={treeWidth}
              onWidthChange={setTreeWidth}
            />
          ) : null}
          <div className="file-preview-subwindow-main">
            <FilePreviewContent
              ref={contentRef}
              connectionId={connectionId}
              entry={entry}
              textMode={textMode}
              onTextModeChange={setTextMode}
              jsonViewMode={jsonViewMode}
              showInlineTextModeToolbar={false}
              editable={entry.kind === "file"}
              onDirtyChange={setDirty}
              onTextPreviewMetaChange={setTextPreviewMeta}
              customIO={customIO}
              sshResourceId={sshResourceId}
            />
          </div>
        </div>
      ) : null}
    </SubWindow>
  );
}

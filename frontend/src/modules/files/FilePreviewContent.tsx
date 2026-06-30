import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { codeEditorLanguageFromPath } from "../../components/ui/CodeEditor";
import {
  ContentPreviewView,
  type ContentPreviewTextMode,
} from "../../components/ui/ContentPreviewView";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import { useSettingsStore } from "../../stores/settingsStore";
import { readRemotePreview, uploadRemote } from "./fileApi";
import {
  decodePreviewBytes,
  parsePreviewJsonText,
  resolveFilePreviewKind,
  type FilePreviewKind,
} from "./filePreviewKind";
import {
  exceedsPreviewThreshold,
  fmtError,
  formatFileSize,
  imageMimeType,
  LOCAL_CONNECTION_ID,
  resolvePreviewReadMaxBytes,
} from "./utils";

export type FileTextPreviewMeta = {
  text: string;
  codeLanguage?: ReturnType<typeof codeEditorLanguageFromPath>;
  /** 结构化 JSON 预览时可切换回源码 */
  jsonStructured?: boolean;
  dirty?: boolean;
};

export type FileJsonViewMode = "structured" | "source";

export type FilePreviewContentHandle = {
  canSave: () => boolean;
  save: () => Promise<void>;
};

export interface FilePreviewContentProps {
  connectionId: string;
  entry: FileEntry;
  textMode?: ContentPreviewTextMode;
  onTextModeChange?: (mode: ContentPreviewTextMode) => void;
  /** false 时由外部（如 SubWindow 标题栏）渲染模式工具栏 */
  showInlineTextModeToolbar?: boolean;
  onTextPreviewMetaChange?: (meta: FileTextPreviewMeta | null) => void;
  /** JSON 文件：structured 为树形视图，source 为源码 */
  jsonViewMode?: FileJsonViewMode;
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

function encodeUtf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function isEditablePreviewKind(kind: FilePreviewKind): boolean {
  return kind === "text" || kind === "json";
}

export const FilePreviewContent = forwardRef<FilePreviewContentHandle, FilePreviewContentProps>(
  function FilePreviewContent(
    {
      connectionId,
      entry,
      textMode,
      onTextModeChange,
      showInlineTextModeToolbar = true,
      onTextPreviewMetaChange,
      jsonViewMode = "structured",
      editable = false,
      onDirtyChange,
    },
    ref,
  ) {
    const { t } = useI18n();
    const thresholdBytes = useSettingsStore((s) => s.filePreviewThresholdBytes);
    const previewKind = resolveFilePreviewKind(entry.name);
    const codeLanguage =
      previewKind === "text" || previewKind === "json"
        ? codeEditorLanguageFromPath(entry.name)
        : undefined;
    const isLocal = connectionId === LOCAL_CONNECTION_ID;
    const downloadHint = isLocal ? undefined : t("files.preview.downloadHint");

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [draftText, setDraftText] = useState<string | null>(null);
    const [jsonContent, setJsonContent] = useState<object | null>(null);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const savedTextRef = useRef<string | null>(null);

    const notifyMeta = useCallback(
      (text: string, options?: { jsonStructured?: boolean; dirty?: boolean }) => {
        if (previewKind !== "text" && previewKind !== "json") {
          onTextPreviewMetaChange?.(null);
          return;
        }
        onTextPreviewMetaChange?.({
          text,
          codeLanguage,
          jsonStructured: options?.jsonStructured,
          dirty: options?.dirty,
        });
      },
      [codeLanguage, onTextPreviewMetaChange, previewKind],
    );

    const applyLoadedText = useCallback(
      (text: string) => {
        savedTextRef.current = text;
        setDraftText(text);
        onDirtyChange?.(false);

      if (previewKind === "json") {
        const parsed = parsePreviewJsonText(text);
        setJsonContent(parsed);
        notifyMeta(text, { jsonStructured: parsed != null, dirty: false });
      } else {
        setJsonContent(null);
        notifyMeta(text, { dirty: false });
      }
    },
    [notifyMeta, onDirtyChange, previewKind],
  );

  useEffect(() => {
    if (previewKind !== "json" || jsonViewMode !== "structured" || draftText == null) return;
    const parsed = parsePreviewJsonText(draftText);
    if (parsed) setJsonContent(parsed);
  }, [draftText, jsonViewMode, previewKind]);

    const handleTextChange = useCallback(
      (next: string) => {
        setDraftText(next);
        const dirty = next !== savedTextRef.current;
        onDirtyChange?.(dirty);
        notifyMeta(next, {
          jsonStructured: previewKind === "json" && jsonContent != null,
          dirty,
        });
      },
      [jsonContent, notifyMeta, onDirtyChange, previewKind],
    );

    const saveDraft = useCallback(async () => {
      if (!editable || !isEditablePreviewKind(previewKind)) {
        throw new Error(t("files.preview.saveNotEditable"));
      }
      const text = draftText;
      if (text == null || text === savedTextRef.current) return;

      await uploadRemote(connectionId, entry.path, encodeUtf8(text));
      savedTextRef.current = text;
      onDirtyChange?.(false);

      if (previewKind === "json") {
        const parsed = parsePreviewJsonText(text);
        setJsonContent(parsed);
        notifyMeta(text, { jsonStructured: parsed != null, dirty: false });
      } else {
        notifyMeta(text, { dirty: false });
      }
    }, [
      connectionId,
      draftText,
      editable,
      entry.path,
      notifyMeta,
      onDirtyChange,
      previewKind,
      t,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        canSave: () =>
          editable &&
          isEditablePreviewKind(previewKind) &&
          draftText != null &&
          draftText !== savedTextRef.current,
        save: saveDraft,
      }),
      [draftText, editable, previewKind, saveDraft],
    );

    useEffect(() => {
      onTextPreviewMetaChange?.(null);
      onDirtyChange?.(false);
    }, [entry.path, onDirtyChange, onTextPreviewMetaChange]);

    useEffect(() => {
      let cancelled = false;
      let objectUrl: string | null = null;

      const fail = (message: string) => {
        if (!cancelled) {
          setError(message);
          setLoading(false);
          onTextPreviewMetaChange?.(null);
          onDirtyChange?.(false);
        }
      };

      setLoading(true);
      setError(null);
      setDraftText(null);
      setJsonContent(null);
      setImageUrl(null);
      savedTextRef.current = null;

      if (previewKind === "unsupported") {
        setLoading(false);
        return () => {
          cancelled = true;
        };
      }

      if (exceedsPreviewThreshold(entry.size, thresholdBytes)) {
        setLoading(false);
        setError(t("files.preview.tooLarge", { limit: formatFileSize(thresholdBytes) }));
        return () => {
          cancelled = true;
        };
      }

      const readMaxBytes = resolvePreviewReadMaxBytes(entry.size, thresholdBytes);

      void (async () => {
        try {
          const bytes = await readRemotePreview(connectionId, entry.path, readMaxBytes);
          if (cancelled) return;

          if (previewKind === "json" || previewKind === "text") {
            applyLoadedText(decodePreviewBytes(bytes));
          } else {
            const blob = new Blob([new Uint8Array(bytes)], { type: imageMimeType(entry.name) });
            objectUrl = URL.createObjectURL(blob);
            setImageUrl(objectUrl);
            onTextPreviewMetaChange?.(null);
          }
          setLoading(false);
        } catch (e) {
          fail(fmtError(e));
        }
      })();

      return () => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }, [
      applyLoadedText,
      connectionId,
      entry.path,
      entry.size,
      entry.name,
      onDirtyChange,
      onTextPreviewMetaChange,
      previewKind,
      t,
      thresholdBytes,
    ]);

    if (previewKind === "unsupported") {
      return (
        <ContentPreviewView
          status="empty"
          emptyMessage={t("files.preview.unsupported")}
          emptyHint={downloadHint}
          showTextModeToolbar={false}
        />
      );
    }

    if (loading) {
      return (
        <ContentPreviewView
          status="loading"
          loadingMessage={t("files.preview.loading")}
          showTextModeToolbar={false}
        />
      );
    }

    if (error) {
      return (
        <ContentPreviewView
          status="error"
          errorMessage={t("files.preview.error", { message: error })}
          emptyHint={downloadHint}
          showTextModeToolbar={false}
        />
      );
    }

    if (previewKind === "image" && imageUrl) {
      return (
        <ContentPreviewView
          status="ready"
          content={{ kind: "image", url: imageUrl, alt: entry.name }}
          showTextModeToolbar={false}
          contentResetKey={entry.path}
        />
      );
    }

    if (previewKind === "json" && jsonContent != null && jsonViewMode === "structured") {
      return (
        <ContentPreviewView
          status="ready"
          content={{ kind: "json", value: jsonContent }}
          showTextModeToolbar={false}
          contentResetKey={entry.path}
        />
      );
    }

    if ((previewKind === "json" || previewKind === "text") && draftText != null) {
      return (
        <ContentPreviewView
          status="ready"
          content={{ kind: "text", text: draftText }}
          codeLanguage={codeLanguage ?? (previewKind === "json" ? "json" : undefined)}
          defaultTextMode="code"
          textMode={textMode}
          onTextModeChange={onTextModeChange}
          showTextModeToolbar={showInlineTextModeToolbar}
          contentResetKey={entry.path}
          editable={editable}
          onTextChange={handleTextChange}
        />
      );
    }

    return (
      <ContentPreviewView
        status="empty"
        emptyMessage={t("files.preview.empty")}
        emptyHint={downloadHint}
        showTextModeToolbar={false}
      />
    );
  },
);

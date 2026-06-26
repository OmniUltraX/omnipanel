import { useEffect, useState } from "react";
import { codeEditorLanguageFromPath } from "../../components/ui/CodeEditor";
import {
  ContentPreviewView,
  type ContentPreviewTextMode,
} from "../../components/ui/ContentPreviewView";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import { useSettingsStore } from "../../stores/settingsStore";
import { readRemotePreview } from "./fileApi";
import { decodePreviewBytes, resolveFilePreviewKind } from "./filePreviewKind";
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
};

export interface FilePreviewContentProps {
  connectionId: string;
  entry: FileEntry;
  textMode?: ContentPreviewTextMode;
  onTextModeChange?: (mode: ContentPreviewTextMode) => void;
  /** false 时由外部（如 SubWindow 标题栏）渲染模式工具栏 */
  showInlineTextModeToolbar?: boolean;
  onTextPreviewMetaChange?: (meta: FileTextPreviewMeta | null) => void;
}

export function FilePreviewContent({
  connectionId,
  entry,
  textMode,
  onTextModeChange,
  showInlineTextModeToolbar = true,
  onTextPreviewMetaChange,
}: FilePreviewContentProps) {
  const { t } = useI18n();
  const thresholdBytes = useSettingsStore((s) => s.filePreviewThresholdBytes);
  const previewKind = resolveFilePreviewKind(entry.name);
  const codeLanguage = previewKind === "text" ? codeEditorLanguageFromPath(entry.name) : undefined;
  const isLocal = connectionId === LOCAL_CONNECTION_ID;
  const downloadHint = isLocal ? undefined : t("files.preview.downloadHint");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    onTextPreviewMetaChange?.(null);
  }, [entry.path, onTextPreviewMetaChange]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const fail = (message: string) => {
      if (!cancelled) {
        setError(message);
        setLoading(false);
        onTextPreviewMetaChange?.(null);
      }
    };

    setLoading(true);
    setError(null);
    setTextContent(null);
    setImageUrl(null);

    if (previewKind === "unsupported") {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (exceedsPreviewThreshold(entry.size, thresholdBytes)) {
      setLoading(false);
      setError(
        t("files.preview.tooLarge", { limit: formatFileSize(thresholdBytes) }),
      );
      return () => {
        cancelled = true;
      };
    }

    const readMaxBytes = resolvePreviewReadMaxBytes(entry.size, thresholdBytes);

    void (async () => {
      try {
        const bytes = await readRemotePreview(connectionId, entry.path, readMaxBytes);
        if (cancelled) return;

        if (previewKind === "text") {
          const text = decodePreviewBytes(bytes);
          setTextContent(text);
          onTextPreviewMetaChange?.({ text, codeLanguage });
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
    codeLanguage,
    connectionId,
    entry.path,
    entry.size,
    entry.name,
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

  if (previewKind === "text" && textContent != null) {
    return (
      <ContentPreviewView
        status="ready"
        content={{ kind: "text", text: textContent }}
        codeLanguage={codeLanguage}
        defaultTextMode="code"
        textMode={textMode}
        onTextModeChange={onTextModeChange}
        showTextModeToolbar={showInlineTextModeToolbar}
        contentResetKey={entry.path}
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
}

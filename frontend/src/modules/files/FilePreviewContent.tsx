import { useEffect, useState } from "react";
import { CodeEditor, codeEditorLanguageFromPath } from "../../components/ui/CodeEditor";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
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
  resolvePreviewReadMaxBytes,
} from "./utils";

export interface FilePreviewContentProps {
  connectionId: string;
  entry: FileEntry;
}

export function FilePreviewContent({ connectionId, entry }: FilePreviewContentProps) {
  const { t } = useI18n();
  const thresholdBytes = useSettingsStore((s) => s.filePreviewThresholdBytes);
  const previewKind = resolveFilePreviewKind(entry.name);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const fail = (message: string) => {
      if (!cancelled) {
        setError(message);
        setLoading(false);
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
          setTextContent(decodePreviewBytes(bytes));
        } else {
          const blob = new Blob([new Uint8Array(bytes)], { type: imageMimeType(entry.name) });
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
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
  }, [connectionId, entry.path, entry.size, previewKind, t, thresholdBytes]);

  if (previewKind === "unsupported") {
    return (
      <ModuleEmptyState
        preset="folder"
        title={t("files.preview.unsupported")}
        desc={t("files.preview.downloadHint")}
      />
    );
  }

  if (loading) {
    return <ModuleEmptyState preset="folder" title={t("files.preview.loading")} />;
  }

  if (error) {
    return (
      <ModuleEmptyState
        preset="folder"
        title={t("files.preview.error", { message: error })}
        desc={t("files.preview.downloadHint")}
      />
    );
  }

  if (previewKind === "image" && imageUrl) {
    return (
      <div className="file-preview-image-wrap">
        <img className="file-preview-image" src={imageUrl} alt={entry.name} decoding="async" />
      </div>
    );
  }

  if (previewKind === "text" && textContent != null) {
    return (
      <div className="file-preview-editor">
        <CodeEditor
          value={textContent}
          onChange={() => {}}
          readOnly
          language={codeEditorLanguageFromPath(entry.name)}
          height="100%"
          className="file-preview-code"
        />
      </div>
    );
  }

  return (
    <ModuleEmptyState
      preset="folder"
      title={t("files.preview.empty")}
      desc={t("files.preview.downloadHint")}
    />
  );
}

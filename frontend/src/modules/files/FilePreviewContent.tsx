import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { codeEditorLanguageFromPath } from "../../components/ui/content/CodeEditor";
import { TextEditorView } from "../../components/textEditor/TextEditorView";
import { createFilePathTextIO } from "../../components/textEditor/io/filePathIO";
import type { TextEditorBytesIO } from "../../components/textEditor/types";
import {
  ContentPreviewView,
  type ContentPreviewTextMode,
} from "../../components/ui/content/ContentPreviewView";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import { useSettingsStore } from "../../stores/settingsStore";
import { readRemotePreview } from "./fileApi";
import {
  decodePreviewBytes,
  detectPreviewKindFromBytes,
  parsePreviewJsonText,
  resolveFilePreviewKind,
  type FilePreviewKind,
} from "./filePreviewKind";
import {
  classifyLargeFile,
  countPreviewLines,
  exceedsPreviewThreshold,
  fmtError,
  FORCE_PREVIEW_MAX_BYTES,
  formatFileSize,
  imageMimeType,
  audioMimeType,
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

export interface FilePreviewIO extends TextEditorBytesIO {}

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
  /**
   * 自定义 IO 适配器。如果提供，FilePreviewContent 内部走该 IO 而非 file_manager 通道
   * （file_manager 用 connectionId 找 file_connections；终端 SSH 资源没有对应的 file_connection，
   *  必须用 SSH 资源 id 走 sftp_download/sftp_upload 通道）。
   */
  customIO?: FilePreviewIO;
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
      customIO,
    },
    ref,
  ) {
    const { t } = useI18n();
    const thresholdBytes = useSettingsStore((s) => s.filePreviewThresholdBytes);
    const initialKind = resolveFilePreviewKind(entry.name);
    // 内容检测覆盖：实际加载后用魔术字节 + NUL 字节检测再校正 kind
    const [detectedKind, setDetectedKind] = useState<FilePreviewKind | null>(null);
    const previewKind = detectedKind ?? initialKind;
    // 大文件策略：normal / truncated (1-10MB) / blocked (>10MB) / unknown
    const largeStrategy = useMemo(
      () => classifyLargeFile(entry.size, thresholdBytes),
      [entry.size, thresholdBytes],
    );
    // 用户点击"强制预览完整文件"时跳过 truncated 截断
    const [forceFull, setForceFull] = useState(false);
    // 当前加载的字节数（用于 banner）
    const [loadedBytes, setLoadedBytes] = useState(0);
    const isTruncatedRead = largeStrategy === "truncated" && !forceFull;
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
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
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

      const readMaxBytes = isTruncatedRead
        ? thresholdBytes
        : resolvePreviewReadMaxBytes(entry.size, thresholdBytes);
      const textIO = createFilePathTextIO({
        connectionId,
        path: entry.path,
        maxBytes: readMaxBytes,
        bytesIO: customIO,
      });
      await textIO.writeText(text);
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
      customIO,
      draftText,
      editable,
      entry.path,
      entry.size,
      isTruncatedRead,
      notifyMeta,
      onDirtyChange,
      previewKind,
      t,
      thresholdBytes,
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
      setAudioUrl(null);
      setDetectedKind(null);
      savedTextRef.current = null;

      if (previewKind === "unsupported") {
        setLoading(false);
        return () => {
          cancelled = true;
        };
      }

      // 大于 10MB 直接禁止预览（即使强制也不行 —— 一次性加载 10MB 字符串会卡）
      if (largeStrategy === "blocked") {
        setLoading(false);
        setError(
          t("files.preview.tooLarge", {
            limit: formatFileSize(FORCE_PREVIEW_MAX_BYTES),
          }) + "（建议用外部工具打开）",
        );
        return () => {
          cancelled = true;
        };
      }

      // truncated 模式：读阈值大小，banner 提示用户可强制预览完整文件
      // normal/unknown 模式：按 entry.size 算 max
      const readMaxBytes = isTruncatedRead
        ? thresholdBytes
        : resolvePreviewReadMaxBytes(entry.size, thresholdBytes);

      void (async () => {
        try {
          const bytes = await (customIO
            ? customIO.readBytes(entry.path, readMaxBytes)
            : readRemotePreview(connectionId, entry.path, readMaxBytes));
          if (cancelled) return;

          setLoadedBytes(bytes.length);

          // 加载完后再做内容检测（魔术字节 / NUL 字节启发式），用于修正扩展名错配或无扩展名的文件
          // 例如 photo.txt 实际是 JPEG、sudoers 无扩展名但内容是文本
          const byteView = new Uint8Array(bytes);
          const detected = detectPreviewKindFromBytes(byteView);
          if (detected && detected !== previewKind) {
            setDetectedKind(detected);
            return;
          }

          if (previewKind === "json" || previewKind === "text") {
            applyLoadedText(decodePreviewBytes(bytes));
          } else if (previewKind === "audio") {
            const blob = new Blob([byteView], { type: audioMimeType(entry.name) });
            objectUrl = URL.createObjectURL(blob);
            setAudioUrl(objectUrl);
            onTextPreviewMetaChange?.(null);
          } else {
            const blob = new Blob([byteView], { type: imageMimeType(entry.name) });
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
      customIO,
      entry.path,
      entry.size,
      entry.name,
      initialKind,
      isTruncatedRead,
      onDirtyChange,
      onTextPreviewMetaChange,
      previewKind,
      t,
      thresholdBytes,
    ]);

    // truncated banner：仅 truncated + 不强制时显示
    const truncatedBanner = useMemo(() => {
      if (largeStrategy !== "truncated" || forceFull) return null;
      const totalSize = formatFileSize(entry.size);
      const loadedSize = formatFileSize(loadedBytes);
      return {
        totalSize,
        loadedSize,
        lines: countPreviewLines(draftText),
      };
    }, [largeStrategy, forceFull, entry.size, loadedBytes, draftText]);

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

    if (previewKind === "audio" && audioUrl) {
      return (
        <ContentPreviewView
          status="ready"
          content={{ kind: "audio", url: audioUrl, mimeType: audioMimeType(entry.name) }}
          showTextModeToolbar={false}
          contentResetKey={entry.path}
        />
      );
    }

    if (previewKind === "json" && jsonContent != null && jsonViewMode === "structured") {
      const inner = (
        <ContentPreviewView
          status="ready"
          content={{ kind: "json", value: jsonContent }}
          showTextModeToolbar={false}
          contentResetKey={entry.path}
        />
      );
      if (truncatedBanner) {
        return (
          <div className="file-preview-truncated">
            <div className="file-preview-truncated-banner">
              <span>
                ⚠ 文件较大，仅显示前 {truncatedBanner.loadedSize} / {truncatedBanner.totalSize}
              </span>
              <button
                type="button"
                className="file-preview-truncated-force"
                onClick={() => setForceFull(true)}
              >
                强制预览完整文件
              </button>
            </div>
            <div className="file-preview-truncated-body">{inner}</div>
          </div>
        );
      }
      return inner;
    }

    if ((previewKind === "json" || previewKind === "text") && draftText != null) {
      const inner = (
        <TextEditorView
          status="ready"
          text={draftText}
          language={codeLanguage ?? (previewKind === "json" ? "json" : undefined)}
          defaultTextMode="code"
          textMode={textMode}
          onTextModeChange={onTextModeChange}
          showInlineTextModeToolbar={showInlineTextModeToolbar}
          contentResetKey={entry.path}
          editable={editable}
          onTextChange={handleTextChange}
        />
      );
      if (truncatedBanner) {
        return (
          <div className="file-preview-truncated">
            <div className="file-preview-truncated-banner">
              <span>
                ⚠ 文件较大，仅显示前 {truncatedBanner.loadedSize} / {truncatedBanner.totalSize}
                {truncatedBanner.lines > 0 ? `（约 ${truncatedBanner.lines} 行）` : ""}
              </span>
              <button
                type="button"
                className="file-preview-truncated-force"
                onClick={() => setForceFull(true)}
              >
                强制预览完整文件
              </button>
            </div>
            <div className="file-preview-truncated-body">{inner}</div>
          </div>
        );
      }
      return inner;
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

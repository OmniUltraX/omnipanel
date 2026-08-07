import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  codeEditorLanguageFromPath,
  normalizeEditorNewlines,
} from "../../components/ui/content/CodeEditor";
import { TextEditorView } from "../../components/textEditor/TextEditorView";
import { createFilePathTextIO } from "../../components/textEditor/io/filePathIO";
import type { TextEditorBytesIO } from "../../components/textEditor/types";
import {
  ContentPreviewView,
  type ContentPreviewTextMode,
} from "../../components/ui/content/ContentPreviewView";
import { useI18n } from "../../i18n";
import type {
  ArchiveListResult,
  ArchiveToolInstallResult,
  FileEntry,
} from "../../ipc/bindings";
import { useSettingsStore } from "../../stores/settingsStore";
import { readRemotePreview } from "./fileApi";
import {
  localLogBackend,
  openLogSession,
  sshLogBackend,
} from "./logApi";
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
  fmtError,
  FORCE_PREVIEW_MAX_BYTES,
  formatFileSize,
  imageMimeType,
  audioMimeType,
  videoMimeType,
  LOCAL_CONNECTION_ID,
  resolvePreviewReadMaxBytes,
} from "./utils";
import { ArchivePreviewView } from "./ArchivePreviewView";
import { LargeLogViewer } from "./LargeLogViewer";

/** 图片 / 音频 / 视频：走 asset 或远程缓存，不整文件读进 JS 内存 */
function isStreamableMediaKind(kind: FilePreviewKind): boolean {
  return kind === "audio" || kind === "image" || kind === "video";
}

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

export type FilePreviewMediaMeta = {
  durationSecs?: number | null;
  size?: number | null;
  posterUrl?: string | null;
};

export type FilePreviewMediaSrc = {
  url: string;
  /** Range 代理令牌；关闭预览时需释放 */
  token?: string | null;
};

export interface FilePreviewIO extends TextEditorBytesIO {
  /**
   * SSH 资源 id（仅在 SSH 远程场景填入）。
   * 用于大日志文件流式预览（>10MB 文本/JSON 分流到 LargeLogViewer）。
   */
  sshResourceId?: string;
  /** 远程媒体：探测时长/大小/封面（不下载整文件） */
  probeMediaMeta?: (path: string, sizeBytes?: number | null) => Promise<FilePreviewMediaMeta>;
  /**
   * 远程媒体预览：返回可供 `<audio>` / `<video>` / `<img>` 使用的 URL。
   * SSH 场景应为本地 Range 代理 URL（边下边播）；本地可为 convertFileSrc。
   */
  resolveMediaSrc?: (
    path: string,
    sizeBytes?: number | null,
  ) => Promise<string | FilePreviewMediaSrc>;
  /** 释放边下边播流令牌（可选） */
  closeMediaStream?: (token: string) => Promise<void>;
  /**
   * 远程压缩包条目列表：远端执行 unzip/tar/7z/unrar 列条目，不下载文件。
   * 仅 SSH 远程场景实现；本地压缩包预览暂不支持。
   */
  listArchiveEntries?: (path: string) => Promise<ArchiveListResult>;
  /** 远端一键安装压缩包工具（unzip/tar/7z/unrar/zstd），返回安装结果。 */
  installArchiveTool?: (tool: string) => Promise<ArchiveToolInstallResult>;
}

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
  /**
   * SSH 资源 id（可选，customIO.sshResourceId 优先）。
   * 用于 >10MB 文本/JSON 日志分流到 LargeLogViewer 流式预览。
   */
  sshResourceId?: string;
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
      sshResourceId: propsSshResourceId,
    },
    ref,
  ) {
    const { t } = useI18n();
    const thresholdBytes = useSettingsStore((s) => s.filePreviewThresholdBytes);
    const initialKind = resolveFilePreviewKind(entry.name);
    // 内容检测覆盖：实际加载后用魔术字节 + NUL 字节检测再校正 kind
    const [detectedKind, setDetectedKind] = useState<FilePreviewKind | null>(null);
    const previewKind = detectedKind ?? initialKind;
    // SSH 资源 id：customIO 优先，props 次之。用于大日志流式预览分流。
    const sshResourceId = customIO?.sshResourceId ?? propsSshResourceId;
    const isLocal = connectionId === LOCAL_CONNECTION_ID;
    const downloadHint = isLocal ? undefined : t("files.preview.downloadHint");

    /**
     * 终端 block 等入口常不带 size（unknown）。
     * 未知大小时先探测，再决定普通预览 vs LargeLogViewer；
     * 避免小文件误进大日志模式（切树后再回来才“正常”的体验）。
     */
    const needsSizeProbe =
      entry.size == null &&
      (initialKind === "text" || initialKind === "json") &&
      (Boolean(sshResourceId) || isLocal);
    const [probedSize, setProbedSize] = useState<number | null>(null);
    const [sizeProbeState, setSizeProbeState] = useState<"idle" | "probing" | "done">(
      () => (entry.size != null || !needsSizeProbe ? "done" : "idle"),
    );

    useEffect(() => {
      setProbedSize(null);
      setSizeProbeState(entry.size != null || !needsSizeProbe ? "done" : "idle");
    }, [entry.path, entry.size, needsSizeProbe]);

    useEffect(() => {
      if (!needsSizeProbe || entry.size != null) return;
      let cancelled = false;
      setSizeProbeState("probing");
      void (async () => {
        try {
          const backend = sshResourceId
            ? sshLogBackend(sshResourceId)
            : localLogBackend();
          const info = await openLogSession(backend, entry.path);
          if (cancelled) return;
          const bytes =
            typeof info.sizeBytes === "number" && Number.isFinite(info.sizeBytes)
              ? info.sizeBytes
              : 0;
          setProbedSize(bytes);
          setSizeProbeState("done");
        } catch {
          if (cancelled) return;
          // SSH 探测失败：保持 null，后续按大日志安全兜底；本地按 0 尝试普通预览
          setProbedSize(sshResourceId ? null : 0);
          setSizeProbeState("done");
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [needsSizeProbe, entry.path, entry.size, sshResourceId]);

    const sizeProbePending = needsSizeProbe && sizeProbeState !== "done";
    const effectiveSize = entry.size ?? probedSize;
    // 大文件策略：探测完成前不按 unknown 分流
    const largeStrategy = useMemo(() => {
      if (sizeProbePending) return "normal";
      // SSH 探测失败（probedSize 仍 null）→ 走 blocked，进入 LargeLogViewer
      if (needsSizeProbe && effectiveSize == null && sshResourceId) return "blocked";
      return classifyLargeFile(effectiveSize, thresholdBytes);
    }, [
      sizeProbePending,
      needsSizeProbe,
      effectiveSize,
      sshResourceId,
      thresholdBytes,
    ]);
    // 用户点击"强制预览完整文件"时跳过 truncated 截断
    const [forceFull, setForceFull] = useState(false);
    // 当前加载的字节数（用于 banner）
    const [loadedBytes, setLoadedBytes] = useState(0);
    const isTruncatedRead = largeStrategy === "truncated" && !forceFull;
    const codeLanguage =
      previewKind === "text" || previewKind === "json"
        ? codeEditorLanguageFromPath(entry.name)
        : undefined;

    const [loading, setLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [draftText, setDraftText] = useState<string | null>(null);
    const [jsonContent, setJsonContent] = useState<object | null>(null);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [mediaPosterUrl, setMediaPosterUrl] = useState<string | null>(null);
    const mediaStreamTokenRef = useRef<string | null>(null);
    const savedTextRef = useRef<string | null>(null);
    const customIORef = useRef(customIO);
    customIORef.current = customIO;

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

  useEffect(() => {
    if (previewKind !== "json" || jsonViewMode !== "structured" || draftText == null) return;
    const parsed = parsePreviewJsonText(draftText);
    if (parsed) setJsonContent(parsed);
  }, [draftText, jsonViewMode, previewKind]);

    const handleTextChange = useCallback(
      (next: string) => {
        const normalized = normalizeEditorNewlines(next);
        setDraftText(normalized);
        const dirty = normalized !== savedTextRef.current;
        onDirtyChange?.(dirty);
        notifyMeta(normalized, {
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
        : resolvePreviewReadMaxBytes(effectiveSize, thresholdBytes);
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
      effectiveSize,
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
      setDetectedKind(null);
    }, [entry.path, onDirtyChange, onTextPreviewMetaChange]);

    useEffect(() => {
      return () => {
        const token = mediaStreamTokenRef.current;
        mediaStreamTokenRef.current = null;
        if (token) {
          void customIORef.current?.closeMediaStream?.(token).catch(() => {});
        }
      };
    }, []);

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
      setLoadingMessage(null);
      setError(null);
      setDraftText(null);
      setJsonContent(null);
      setImageUrl(null);
      setAudioUrl(null);
      setVideoUrl(null);
      setMediaPosterUrl(null);
      savedTextRef.current = null;

      const prevToken = mediaStreamTokenRef.current;
      mediaStreamTokenRef.current = null;
      if (prevToken) {
        void customIORef.current?.closeMediaStream?.(prevToken).catch(() => {});
      }

      if (initialKind === "unsupported") {
        setLoading(false);
        return () => {
          cancelled = true;
        };
      }

      // size 探测中：先不要读字节（SSH 整文件下载很危险）
      if (sizeProbePending) {
        setLoading(true);
        return () => {
          cancelled = true;
        };
      }

      // 压缩包：由 ArchivePreviewView 自管数据拉取（远端 exec 列条目，不下载字节）
      if (initialKind === "archive") {
        setLoading(false);
        onTextPreviewMetaChange?.(null);
        return () => {
          cancelled = true;
        };
      }

      const applyMediaSrc = (src: string, kind: FilePreviewKind) => {
        if (kind === "audio") setAudioUrl(src);
        else if (kind === "video") setVideoUrl(src);
        else setImageUrl(src);
        onTextPreviewMetaChange?.(null);
        setLoading(false);
      };

      // 本地媒体：convertFileSrc 直接播，不读进 JS、也不受 10MB 预览阈值限制
      if (isLocal && isStreamableMediaKind(initialKind)) {
        try {
          applyMediaSrc(convertFileSrc(entry.path), initialKind);
        } catch (e) {
          fail(fmtError(e));
        }
        return () => {
          cancelled = true;
        };
      }

      // 远程媒体：立刻开 Range 流并进入播放器（边下边播，无 10MB 限制）
      if (
        !isLocal &&
        isStreamableMediaKind(initialKind) &&
        customIO?.resolveMediaSrc
      ) {
        setLoadingMessage(t("files.preview.startingStream"));
        const resolveMediaSrc = customIO.resolveMediaSrc;
        const probe = customIO.probeMediaMeta;
        void (async () => {
          try {
            // 封面探测与开流并行；开流优先，探测失败不影响播放
            const streamPromise = resolveMediaSrc(entry.path, entry.size);
            if (probe && initialKind === "video") {
              void probe(entry.path, entry.size)
                .then((meta) => {
                  if (cancelled) return;
                  if (meta.posterUrl) setMediaPosterUrl(meta.posterUrl);
                })
                .catch(() => {});
            }
            const result = await streamPromise;
            if (cancelled) return;
            const src = typeof result === "string" ? result : result.url;
            const token = typeof result === "string" ? null : result.token ?? null;
            if (token) mediaStreamTokenRef.current = token;
            applyMediaSrc(src, initialKind);
          } catch (e) {
            fail(fmtError(e));
          }
        })();
        return () => {
          cancelled = true;
        };
      }

      // 大于 10MB 直接禁止预览（即使强制也不行 —— 一次性加载 10MB 字符串会卡）
      // 流式媒体走 asset/缓存路径，不受该阈值限制
      // text/json 超大文件由下方 LargeLogViewer 分流（须先完成 size 探测）
      const canStreamLargeText =
        (initialKind === "text" || initialKind === "json") &&
        (Boolean(sshResourceId) || isLocal);
      if (canStreamLargeText && largeStrategy === "blocked") {
        setLoading(false);
        return () => {
          cancelled = true;
        };
      }
      if (
        largeStrategy === "blocked" &&
        !isStreamableMediaKind(initialKind) &&
        !canStreamLargeText
      ) {
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
      // normal 模式：按有效 size 算 max
      const readMaxBytes = isTruncatedRead
        ? thresholdBytes
        : resolvePreviewReadMaxBytes(effectiveSize, thresholdBytes);

      void (async () => {
        try {
          const bytes = await (customIO
            ? customIO.readBytes(entry.path, readMaxBytes)
            : readRemotePreview(connectionId, entry.path, readMaxBytes));
          if (cancelled) return;

          setLoadedBytes(bytes.length);

          // 加载完后再做内容检测（魔术字节 / NUL 启发式），修正扩展名错配；
          // 同一趟直接按有效 kind 渲染，禁止 setDetectedKind 后 return 再触发整轮重载
          // （否则会与 path effect 清 detectedKind 形成 loading ↔ empty 闪烁）。
          const byteView = new Uint8Array(bytes);
          const detected = detectPreviewKindFromBytes(byteView);
          let effectiveKind: FilePreviewKind = initialKind;
          if (detected) {
            const demoteMediaToUnsupported =
              detected === "unsupported" && isStreamableMediaKind(initialKind);
            if (!demoteMediaToUnsupported) {
              effectiveKind = detected;
              // 仅用于 UI kind 展示；勿让它进入 effect deps 触发整文件重载
              if (detected !== initialKind) {
                setDetectedKind(detected);
              }
            }
          }

          if (effectiveKind === "unsupported") {
            setLoading(false);
            return;
          }

          if (effectiveKind === "json" || effectiveKind === "text") {
            const text = normalizeEditorNewlines(decodePreviewBytes(bytes));
            savedTextRef.current = text;
            setDraftText(text);
            onDirtyChange?.(false);
            if (effectiveKind === "json") {
              const parsed = parsePreviewJsonText(text);
              setJsonContent(parsed);
              onTextPreviewMetaChange?.({
                text,
                codeLanguage: codeEditorLanguageFromPath(entry.name),
                jsonStructured: parsed != null,
                dirty: false,
              });
            } else {
              setJsonContent(null);
              onTextPreviewMetaChange?.({
                text,
                codeLanguage: codeEditorLanguageFromPath(entry.name),
                dirty: false,
              });
            }
          } else if (effectiveKind === "audio") {
            const blob = new Blob([byteView], { type: audioMimeType(entry.name) });
            objectUrl = URL.createObjectURL(blob);
            setAudioUrl(objectUrl);
            onTextPreviewMetaChange?.(null);
          } else if (effectiveKind === "video") {
            const blob = new Blob([byteView], { type: videoMimeType(entry.name) });
            objectUrl = URL.createObjectURL(blob);
            setVideoUrl(objectUrl);
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
      // 注意：不要依赖 previewKind / detectedKind，避免检测结果写回后再次整文件重载
      // eslint-disable-next-line react-hooks/exhaustive-deps -- initialKind 已覆盖扩展名变化
    }, [
      connectionId,
      customIO,
      entry.path,
      entry.size,
      entry.name,
      effectiveSize,
      initialKind,
      isLocal,
      isTruncatedRead,
      largeStrategy,
      onDirtyChange,
      onTextPreviewMetaChange,
      sizeProbePending,
      sshResourceId,
      t,
      thresholdBytes,
    ]);

    // truncated banner：仅 truncated + 不强制时显示
    const truncatedBanner = useMemo(() => {
      if (largeStrategy !== "truncated" || forceFull) return null;
      const totalSize = formatFileSize(effectiveSize);
      const loadedSize = formatFileSize(loadedBytes);
      return {
        totalSize,
        loadedSize,
        lines: countPreviewLines(draftText ?? ""),
      };
    }, [largeStrategy, forceFull, effectiveSize, loadedBytes, draftText]);

    // 大日志分流：仅确认超大（blocked）后进入；size 探测中先 loading
    if (sizeProbePending && (previewKind === "text" || previewKind === "json")) {
      return (
        <ContentPreviewView
          status="loading"
          loadingMessage={t("files.preview.loading")}
          showTextModeToolbar={false}
        />
      );
    }

    if (
      largeStrategy === "blocked" &&
      (previewKind === "text" || previewKind === "json")
    ) {
      if (sshResourceId) {
        return <LargeLogViewer sshId={sshResourceId} path={entry.path} />;
      }
      if (isLocal) {
        return <LargeLogViewer local path={entry.path} />;
      }
    }

    if (previewKind === "archive") {
      return (
        <ArchivePreviewView
          entry={entry}
          customIO={customIO}
          isLocal={isLocal}
          downloadHint={downloadHint}
        />
      );
    }

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
          loadingMessage={loadingMessage ?? t("files.preview.loading")}
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

    if (previewKind === "video" && videoUrl) {
      return (
        <ContentPreviewView
          status="ready"
          content={{
            kind: "video",
            url: videoUrl,
            mimeType: videoMimeType(entry.name),
            poster: mediaPosterUrl ?? undefined,
          }}
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

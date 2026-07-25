import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../../i18n";
import type { ArchiveListResult, FileEntry } from "../../ipc/bindings";
import { formatFileSize } from "./utils";
import { errorToString } from "../../lib/errorToString";
import type { FilePreviewIO } from "./FilePreviewContent";

const ROW_HEIGHT = 28;

export interface ArchivePreviewViewProps {
  entry: FileEntry;
  customIO?: FilePreviewIO;
  isLocal: boolean;
  downloadHint?: string;
}

interface ArchiveViewState {
  result: ArchiveListResult | null;
  loading: boolean;
  error: string | null;
  installing: string | null;
  installMessage: string | null;
}

export function ArchivePreviewView({
  entry,
  customIO,
  isLocal,
  downloadHint,
}: ArchivePreviewViewProps) {
  const { t } = useI18n();
  const [state, setState] = useState<ArchiveViewState>({
    result: null,
    loading: true,
    error: null,
    installing: null,
    installMessage: null,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const currentPathRef = useRef(entry.path);
  const ioRef = useRef(customIO);
  ioRef.current = customIO;

  const fetchEntries = useCallback(async (path: string) => {
    const io = ioRef.current;
    if (!io?.listArchiveEntries) {
      setState({
        result: null,
        loading: false,
        error: null,
        installing: null,
        installMessage: null,
      });
      return;
    }
    setState((s) => ({
      ...s,
      loading: true,
      error: null,
      installMessage: null,
    }));
    try {
      const result = await io.listArchiveEntries(path);
      if (currentPathRef.current !== path) return;
      setState({
        result,
        loading: false,
        error: null,
        installing: null,
        installMessage: null,
      });
    } catch (e) {
      if (currentPathRef.current !== path) return;
      setState({
        result: null,
        loading: false,
        error: errorToString(e),
        installing: null,
        installMessage: null,
      });
    }
  }, []);

  useEffect(() => {
    currentPathRef.current = entry.path;
    void fetchEntries(entry.path);
  }, [entry.path, fetchEntries]);

  const handleInstallTool = useCallback(
    async (tool: string) => {
      const io = ioRef.current;
      if (!io?.installArchiveTool) return;
      setState((s) => ({ ...s, installing: tool, installMessage: null }));
      try {
        const result = await io.installArchiveTool(tool);
        if (currentPathRef.current !== entry.path) return;
        if (result.installed) {
          setState((s) => ({
            ...s,
            installing: null,
            installMessage: result.message,
          }));
          // 重新拉取条目
          void fetchEntries(entry.path);
        } else {
          setState((s) => ({
            ...s,
            installing: null,
            installMessage: result.message,
          }));
        }
      } catch (e) {
        setState((s) => ({
          ...s,
          installing: null,
          installMessage: errorToString(e),
        }));
      }
    },
    [entry.path, fetchEntries],
  );

  // 排序：目录在前，按名称排序（不区分大小写）
  const sortedEntries = useMemo(() => {
    const list = state.result?.entries ?? [];
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [state.result?.entries]);

  const virtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 32,
  });

  // ===== 渲染分支 =====

  // 本地压缩包：暂不支持（远端 exec 通道未实现）
  if (!customIO?.listArchiveEntries) {
    return (
      <div className="archive-preview-empty">
        <div className="archive-preview-empty-icon">📦</div>
        <div className="archive-preview-empty-title">
          {isLocal
            ? "本地压缩包预览暂不支持"
            : t("files.preview.unsupported")}
        </div>
        <div className="archive-preview-empty-hint">
          {isLocal
            ? "请通过 SSH 远程连接查看远端压缩包条目"
            : downloadHint}
        </div>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="archive-preview-loading">
        <div className="archive-preview-spinner" />
        <div className="archive-preview-loading-text">
          {t("files.preview.loading")}
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="archive-preview-empty">
        <div className="archive-preview-empty-icon">⚠</div>
        <div className="archive-preview-empty-title">
          {t("files.preview.error", { message: state.error })}
        </div>
        <button
          type="button"
          className="archive-preview-retry-btn"
          onClick={() => void fetchEntries(entry.path)}
        >
          重试
        </button>
      </div>
    );
  }

  // 远端工具缺失：展示一键安装按钮
  if (state.result?.toolMissing) {
    const tool = state.result.toolMissing;
    return (
      <div className="archive-preview-empty">
        <div className="archive-preview-empty-icon">📦</div>
        <div className="archive-preview-empty-title">
          远端缺少工具 <code>{tool}</code>
        </div>
        <div className="archive-preview-empty-hint">
          需要在远端安装 <code>{tool}</code> 才能列出压缩包条目
        </div>
        <button
          type="button"
          className="archive-preview-install-btn"
          disabled={state.installing === tool}
          onClick={() => void handleInstallTool(tool)}
        >
          {state.installing === tool ? "安装中..." : `一键安装 ${tool}`}
        </button>
        {state.installMessage ? (
          <pre className="archive-preview-install-message">
            {state.installMessage}
          </pre>
        ) : null}
      </div>
    );
  }

  if (!state.result || sortedEntries.length === 0) {
    return (
      <div className="archive-preview-empty">
        <div className="archive-preview-empty-icon">📦</div>
        <div className="archive-preview-empty-title">
          {t("files.preview.empty")}
        </div>
      </div>
    );
  }

  const format = state.result.format;
  const totalCount = state.result.entries.length;
  const fileCount = state.result.entries.filter((e) => !e.isDir).length;
  const totalSize = state.result.totalUncompressed;

  return (
    <div className="archive-preview">
      <div className="archive-preview-header">
        <div className="archive-preview-meta">
          <span className="archive-preview-format-badge">{format}</span>
          <span className="archive-preview-meta-item">
            共 {totalCount} 项（{fileCount} 文件）
          </span>
          <span className="archive-preview-meta-item">
            解压后 {formatFileSize(totalSize)}
          </span>
          {entry.size != null ? (
            <span className="archive-preview-meta-item">
              压缩包 {formatFileSize(entry.size)}
            </span>
          ) : null}
        </div>
        {state.installMessage ? (
          <pre className="archive-preview-install-message archive-preview-install-message--inline">
            {state.installMessage}
          </pre>
        ) : null}
      </div>
      <div className="archive-preview-list" ref={scrollRef}>
        <div
          className="archive-preview-list-inner"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const e = sortedEntries[item.index]!;
            return (
              <div
                key={item.key}
                className="archive-preview-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
                title={e.name}
              >
                <span className={`archive-preview-row-icon${e.isDir ? " is-dir" : ""}`}>
                  {e.isDir ? "📁" : "📄"}
                </span>
                <span className="archive-preview-row-name" title={e.name}>
                  {e.name}
                </span>
                <span className="archive-preview-row-size">
                  {e.isDir ? "—" : formatFileSize(e.size)}
                </span>
                <span className="archive-preview-row-time">
                  {e.modified != null ? formatArchiveTime(e.modified) : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatArchiveTime(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

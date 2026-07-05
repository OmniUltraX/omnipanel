import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../menu/ContextMenu";

export interface LogViewerProps {
  /** 日志全文，写�?xterm 展示 */
  text?: string;
  loading?: boolean;
  loadingText?: string;
  emptyText?: string;
  error?: string | null;
  /** 工具栏左侧扩展区（筛选、刷新等�?*/
  toolbar?: ReactNode;
  footer?: ReactNode;
  onClear?: () => void | Promise<void>;
  showClear?: boolean;
  autoScroll?: boolean;
  /** 流式追加模式：text 仅增长时在末尾增量写入，避免整页重绘 */
  streaming?: boolean;
  /** 选中即复制到剪贴�?*/
  copyOnSelect?: boolean;
  /** Tab 隐藏/显示切换时触�?refit（hidden 期间容器尺寸�?0�?*/
  visible?: boolean;
  className?: string;
}

function normalizeLogNewlines(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function readAllTerminalText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function readLogTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: get("--bg-deeper", "#1a1717"),
    foreground: get("--fg", "#fdfcfc"),
    cursor: get("--bg-deeper", "#1a1717"),
    selectionBackground: get("--accent-soft", "rgba(0, 122, 255, 0.12)"),
    black: get("--bg-deeper", "#1a1717"),
    red: get("--danger", "#ff3b30"),
    green: get("--success", "#30d158"),
    yellow: get("--warn", "#ff9f0a"),
    blue: get("--accent", "#007aff"),
    magenta: "#da77f2",
    cyan: "#66d9e8",
    white: get("--fg", "#fdfcfc"),
    brightBlack: get("--muted", "#9a9898"),
    brightRed: get("--danger", "#ff3b30"),
    brightGreen: get("--success", "#30d158"),
    brightYellow: get("--warn", "#ff9f0a"),
    brightBlue: get("--accent", "#007aff"),
    brightMagenta: "#e599f7",
    brightCyan: "#99e9f2",
    brightWhite: get("--fg", "#fdfcfc"),
  };
}

function isTerminalAtBottom(term: Terminal): boolean {
  const buf = term.buffer.active;
  return buf.baseY + term.rows >= buf.length;
}

export function LogViewer({
  text = "",
  loading = false,
  loadingText,
  emptyText,
  error,
  toolbar,
  footer,
  onClear,
  showClear,
  autoScroll = true,
  streaming = false,
  copyOnSelect = true,
  visible = true,
  className,
}: LogViewerProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const autoScrollRef = useRef(autoScroll);
  const lastTextRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const canClear = showClear ?? Boolean(onClear);
  const showToolbar = Boolean(toolbar) || canClear;
  const showLoadingOverlay = loading && !text;
  const showEmptyOverlay = !loading && !text && !error;

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12,
      lineHeight: 1.6,
      fontFamily:
        '"Berkeley Mono", "IBM Plex Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Liberation Mono", ui-monospace, monospace',
      scrollback: 10000,
      theme: readLogTerminalTheme(),
      allowTransparency: true,
    });
    (term.options as typeof term.options & { copyOnSelect?: boolean }).copyOnSelect = copyOnSelect;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    const onScroll = () => {
      autoScrollRef.current = isTerminalAtBottom(term);
    };
    const scrollDisposable = term.onScroll(onScroll);

    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      fitAddon.fit();
    });
    resizeObserver.observe(el);

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY });
    };
    el.addEventListener("contextmenu", onContextMenu);

    return () => {
      el.removeEventListener("contextmenu", onContextMenu);
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      lastTextRef.current = null;
    };
  }, [copyOnSelect]);

  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;

    const frame = requestAnimationFrame(() => {
      fitAddon.fit();
      term.refresh(0, Math.max(term.rows - 1, 0));
      if (autoScrollRef.current) {
        term.scrollToBottom();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (lastTextRef.current === text) return;

    const prev = lastTextRef.current ?? "";
    const stickToBottom = autoScrollRef.current && (lastTextRef.current === null || isTerminalAtBottom(term));
    lastTextRef.current = text;

    const finishWrite = () => {
      if (stickToBottom) {
        term.scrollToBottom();
        autoScrollRef.current = true;
      }
    };

    if (streaming && prev && text.startsWith(prev) && text.length > prev.length) {
      const delta = text.slice(prev.length);
      term.write(normalizeLogNewlines(delta), finishWrite);
      return;
    }

    term.reset();
    if (text) {
      term.write(normalizeLogNewlines(text), finishWrite);
    }
  }, [text, streaming]);

  const handleClear = useCallback(() => {
    const term = termRef.current;
    if (term) {
      term.reset();
      lastTextRef.current = "";
    }
    void onClear?.();
  }, [onClear]);

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    await navigator.clipboard.writeText(term.getSelection());
  }, []);

  const copyAll = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const payload = text || readAllTerminalText(term);
    if (!payload) return;
    await navigator.clipboard.writeText(payload);
  }, [text]);

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    const term = termRef.current;
    const hasSelection = Boolean(term?.hasSelection());
    return [
      {
        id: "copy-selection",
        label: t("logViewer.copySelection"),
        disabled: !hasSelection,
        onClick: () => void copySelection(),
      },
      {
        id: "copy-all",
        label: t("logViewer.copyAll"),
        disabled: !text,
        onClick: () => void copyAll(),
      },
    ];
  }, [contextMenu, copyAll, copySelection, t, text]);

  const panelClass = className ? `log-viewer-panel ${className}` : "log-viewer-panel";

  return (
    <div className={panelClass}>
      {showToolbar && (
        <div className="log-viewer-panel__toolbar">
          <div className="log-viewer-panel__toolbar-start">{toolbar}</div>
          {canClear && (
            <div className="log-viewer-panel__toolbar-actions">
              <button type="button" className="log-viewer-panel__btn" onClick={handleClear}>
                {t("logViewer.clear")}
              </button>
            </div>
          )}
        </div>
      )}
      {error ? <div className="log-viewer-panel__error">{error}</div> : null}
      <div className="log-viewer-panel__xterm">
        <div ref={containerRef} className="log-viewer-panel__xterm-host" />
        {showLoadingOverlay ? (
          <div className="log-viewer-panel__overlay">{loadingText ?? t("common.loading")}</div>
        ) : null}
        {showEmptyOverlay ? (
          <div className="log-viewer-panel__overlay">{emptyText ?? t("logViewer.empty")}</div>
        ) : null}
      </div>
      {footer ? <div className="log-viewer-panel__footer">{footer}</div> : null}
      {contextMenu ? (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

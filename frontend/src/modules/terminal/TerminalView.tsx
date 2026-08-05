import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { useTerminal, type TerminalInputMode } from "../../hooks/useTerminal";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import {
  findTerminalPane,
  useTerminalStore,
} from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import type { TerminalBlock } from "../../stores/blocksStore";
import {
  getMockCommandOutput,
  getPromptPrefix,
  seedMockTerminal,
} from "./mockTerminal";
import { getTerminalTheme } from "./terminalTheme";
import { triggerAiDrawerToggle } from "../../hooks/useAiDrawerShortcut";
import { commands } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { writeTerminalRaw } from "./terminalPaneSenders";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type TerminalViewProps = {
  sessionId: string;
  resource: WorkspaceResource | null;
  startup: string[];
  active: boolean;
  inputMode?: TerminalInputMode;
  liveNative?: boolean;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onBlockRightClick?: (block: TerminalBlock, position: { x: number; y: number }) => void;
  /** 自增时强制 useTerminal 重新初始化（用于刷新按钮） */
  reconnectKey?: number;
};

export function TerminalView({
  sessionId,
  resource,
  startup,
  active,
  inputMode = "external",
  liveNative = false,
  onSenderChange,
  onBlockRightClick,
  reconnectKey,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<((cmd: string) => void) | null>(null);
  const setStatus = useTerminalStore((state) => state.setStatus);
  const moduleSuspended = useModuleSuspended();
  const terminalSuspended = !isTauriRuntime || moduleSuspended;

  // 终端文件链接：cwd / sessionType 从 store 拿
  // 注意：避免在 selector 中返回新对象（zustand 默认 Object.is 比较，会触发 re-render）
  // 拆成两个 selector，分别只取 string（cwd）和 string（sessionType），都是稳定引用
  const paneCwd = useTerminalStore((state) => {
    const pane = findTerminalPane(sessionId);
    if (pane) return pane.cwd || "/";
    const tab = state.tabs.find((item) => item.id === sessionId);
    return tab?.session?.cwd || "/";
  });
  const paneType = useTerminalStore((state) => {
    const pane = findTerminalPane(sessionId);
    if (pane) return pane.type;
    const tab = state.tabs.find((item) => item.id === sessionId);
    return tab?.session?.type ?? "local";
  });
  const composedFileLink = useMemo(
    () => ({
      sessionType: paneType,
      resourceId: resource?.id ?? null,
      remoteHome: null,
      cwd: paneCwd,
      paneId: sessionId,
    }),
    [paneType, paneCwd, resource, sessionId],
  );

  const paneStatus = useTerminalStore((state) => {
    const pane = findTerminalPane(sessionId);
    if (pane) return pane.status;
    return state.tabs.find((item) => item.id === sessionId)?.status;
  });

  const storeReconnectVersion = useTerminalStore(
    (state) => state.reconnectVersions[sessionId] ?? 0,
  );
  const effectiveReconnectKey = (reconnectKey ?? 0) + storeReconnectVersion;
  const effectiveInputMode: TerminalInputMode =
    liveNative && inputMode === "external" ? "interactive" : inputMode;

  useTerminal(
    sessionId,
    containerRef,
    undefined,
    undefined,
    onBlockRightClick,
    terminalSuspended,
    {
      inputMode: effectiveInputMode,
      sendRef,
      active: active && !moduleSuspended,
      reconnectKey: effectiveReconnectKey,
      fileLink: composedFileLink,
    },
  );

  useEffect(() => {
    if (!isTauriRuntime) return;
    if (!active) {
      onSenderChange(sessionId, null);
      return;
    }
    onSenderChange(sessionId, sendRef.current);
    return () => {
      onSenderChange(sessionId, null);
    };
  }, [active, onSenderChange, paneStatus, sessionId]);

  useEffect(() => {
    if (isTauriRuntime) return;
    const container = containerRef.current;
    if (!container) return;

    const settings = useSettingsStore.getState();
    const term = new Terminal({
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      fontSize: settings.terminalFontSize,
      fontFamily: `"${settings.terminalFontFamily}", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace`,
      lineHeight: settings.terminalLineHeight,
      theme: getTerminalTheme(settings.resolved),
      scrollback: settings.terminalScrollback,
      allowTransparency: false,
    });
    (term.options as typeof term.options & { copyOnSelect?: boolean }).copyOnSelect =
      settings.terminalCopyOnSelect;

    term.open(container);
    term.attachCustomKeyEventHandler((e) => triggerAiDrawerToggle(e));
    termRef.current = term;
    seedMockTerminal(term, resource, startup);
    setStatus(sessionId, "connected");
    onSenderChange(sessionId, (cmd: string) => {
      const prompt = getPromptPrefix(resource);
      const resourceName = resource?.name ?? "omnipanel";
      term.writeln("");
      term.writeln(`\x1b[32m${prompt}\x1b[0m ${cmd}`);
      getMockCommandOutput(cmd, resourceName).forEach((line) => term.writeln(line));
      term.writeln("");
      term.write(`\x1b[32m${prompt}\x1b[0m `);
    });

    return () => {
      onSenderChange(sessionId, null);
      setStatus(sessionId, "disconnected");
      term.dispose();
      termRef.current = null;
    };
  }, [onSenderChange, resource, sessionId, setStatus, startup]);

  // 主题变化时动态更新终端主题（web 版终端）
  useEffect(() => {
    const unsub = useSettingsStore.subscribe((state, prev) => {
      if (state.resolved !== prev.resolved) {
        const term = termRef.current;
        if (term) {
          term.options.theme = getTerminalTheme(state.resolved);
        }
      }
    });
    return unsub;
  }, []);

  // ─── 拖拽上传 ───────────────────────────────────────────────
  const { t } = useI18n();
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const hasFileDrag = (dt: DataTransfer | null): boolean => {
    if (!dt) return false;
    if (dt.types.includes("Files")) return true;
    return Array.from(dt.items ?? []).some((item) => item.kind === "file");
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = async (e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    if (paneType === "remote" && resource?.id) {
      // 远端终端：走传输引擎上传到 cwd
      const destDir = paneCwd || "/";
      for (const file of Array.from(files)) {
        if (!file.name) continue;
        try {
          const buffer = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          const result = await commands.fileTransferUploadLocalBytes(
            file.name,
            bytes,
            resource.id,
            destDir,
            "overwrite",
          );
          if (result.status !== "ok") {
            console.error(`[Terminal] 上传 ${file.name} 失败:`, result.error?.message);
          }
        } catch (err) {
          console.error(`[Terminal] 上传 ${file.name} 异常:`, err);
        }
      }
    } else {
      // 本地终端：插入文件路径到 PTY（不自动回车）
      const paths = Array.from(files)
        .filter((f) => f.name)
        .map((f) => {
          // 浏览器 File 对象有 path 属性（Tauri 环境）或用 name
          const path = (f as File & { path?: string }).path;
          return path || f.name;
        });
      if (paths.length > 0) {
        // 用空格连接多个路径，每个路径用引号包裹（处理空格和特殊字符）
        const quoted = paths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(" ");
        writeTerminalRaw(sessionId, quoted);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={`term-xterm-wrap${inputMode === "external" ? " term-xterm-wrap--live" : ""}${liveNative ? " term-xterm-wrap--live-native" : ""}${dragOver ? " term-xterm-wrap--drag-over" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {dragOver ? (
        <div className="term-drop-overlay" aria-hidden>
          {paneType === "remote"
            ? t("ssh.sftp.dropHint")
            : t("terminal.dropInsertPath")}
        </div>
      ) : null}
    </div>
  );
}

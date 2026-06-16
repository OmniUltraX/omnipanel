import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const EXEC_SHELLS = ["/bin/bash", "/bin/sh", "bash", "sh"];

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

function isShellStartupFailure(output: string) {
  const msg = output.toLowerCase();
  return (
    msg.includes("进入容器终端超时") ||
    msg.includes("container terminal timed out") ||
    msg.includes("executable file not found") ||
    msg.includes("no such file or directory") ||
    msg.includes("oci runtime exec failed") ||
    msg.includes(": not found")
  );
}

async function closeExecSession(sessionId: string | null) {
  if (!sessionId) return;
  try {
    await commands.dockerExecClose(sessionId);
  } catch {
    // 会话可能已被后端回收
  }
}

/**
 * 容器交互终端。挂载后创建一次 exec 会话，Tab 切换仅隐藏不销毁，避免 SSH PTY 反复创建泄漏。
 */
export function DockerExecTerminal({
  connectionId,
  containerId,
  visible,
}: {
  connectionId: string;
  containerId: string;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);
  const shellIndexRef = useRef(0);
  const shellOutputRef = useRef("");
  const sessionStartedAtRef = useRef(0);
  const hasUserInputRef = useRef(false);
  const visibleRef = useRef(visible);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isTauriRuntime || startedRef.current) return;
    startedRef.current = true;

    let destroyed = false;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenEvent: UnlistenFn | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      theme: { background: "#1a1717", foreground: "#f4f1ed", cursor: "#f4f1ed" },
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();
    term.writeln("\x1b[90m正在进入容器…\x1b[0m");
    termRef.current = term;
    fitRef.current = fitAddon;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const startSession = async (shellIndex: number) => {
      const shell = EXEC_SHELLS[shellIndex];
      shellIndexRef.current = shellIndex;
      shellOutputRef.current = "";
      sessionIdRef.current = null;
      sessionStartedAtRef.current = 0;
      hasUserInputRef.current = false;

      try {
        if (destroyed) return;

        const cols = Math.max(term.cols, 80);
        const rows = Math.max(term.rows, 24);
        term.writeln(`\x1b[90m正在尝试 ${shell}…\x1b[0m`);
        const res = await commands.dockerCreateExecSession(
          connectionId,
          containerId,
          shell,
          cols,
          rows,
        );

        if (destroyed) {
          if (res.status === "ok") {
            await closeExecSession(res.data);
          }
          return;
        }

        if (res.status === "ok") {
          sessionIdRef.current = res.data;
          sessionStartedAtRef.current = Date.now();
          term.reset();
          term.focus();
          void commands.dockerExecResize(
            res.data,
            Math.max(term.cols, 80),
            Math.max(term.rows, 24),
          );
        } else {
          if (isShellStartupFailure(res.error.message) && shellIndex < EXEC_SHELLS.length - 1) {
            await startSession(shellIndex + 1);
            return;
          }
          startedRef.current = false;
          term.writeln(`\r\n\x1b[31m无法进入容器：${res.error.message}\x1b[0m`);
        }
      } catch (e) {
        if (!destroyed) {
          startedRef.current = false;
          term.writeln(`\r\n\x1b[31m无法进入容器：${String(e)}\x1b[0m`);
        }
      }
    };

    const start = async () => {
      unlistenOutput = await listen<{ session_id: string; data: string }>(
        "terminal-output",
        (ev) => {
          if (destroyed || ev.payload.session_id !== sessionIdRef.current) return;
          const data = decodeBase64(ev.payload.data);
          shellOutputRef.current += decoder.decode(data, { stream: true });
          if (shellOutputRef.current.length > 4096) {
            shellOutputRef.current = shellOutputRef.current.slice(-4096);
          }
          term.write(data);
        },
      );
      unlistenEvent = await listen<{ session_id: string; event: string }>(
        "terminal-event",
        (ev) => {
          if (destroyed || ev.payload.session_id !== sessionIdRef.current) return;
          if (ev.payload.event !== "exited") return;

          const exitedSession = sessionIdRef.current;
          sessionIdRef.current = null;
          const shellIndex = shellIndexRef.current;
          const startupWindowMs = Date.now() - sessionStartedAtRef.current;
          const shouldRetry =
            startupWindowMs < 5000 &&
            !hasUserInputRef.current &&
            isShellStartupFailure(shellOutputRef.current) &&
            shellIndex < EXEC_SHELLS.length - 1;

          if (shouldRetry) {
            const nextShell = EXEC_SHELLS[shellIndex + 1];
            term.writeln(`\r\n\x1b[33m当前 shell 不可用，正在切换到 ${nextShell}…\x1b[0m`);
            void closeExecSession(exitedSession).finally(() => {
              if (!destroyed) void startSession(shellIndex + 1);
            });
            return;
          }

          term.writeln("\r\n\x1b[33m[会话已结束]\x1b[0m");
        },
      );

      await startSession(0);
    };

    void start();

    const dataDisposable = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      hasUserInputRef.current = true;
      void commands.dockerExecWrite(sid, Array.from(encoder.encode(data)));
    });

    resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current || !fitAddon || !term) return;
      fitAddon.fit();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const sid = sessionIdRef.current;
        if (destroyed || !visibleRef.current || !sid || !term) return;
        void commands.dockerExecResize(
          sid,
          Math.max(term.cols, 1),
          Math.max(term.rows, 1),
        );
      }, 120);
    });
    resizeObserver.observe(el);

    return () => {
      destroyed = true;
      startedRef.current = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      dataDisposable.dispose();
      resizeObserver?.disconnect();
      unlistenOutput?.();
      unlistenEvent?.();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      void closeExecSession(sid);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [connectionId, containerId]);

  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;

    const frame = requestAnimationFrame(() => {
      fitAddon.fit();
      const sid = sessionIdRef.current;
      if (sid) {
        void commands.dockerExecResize(sid, Math.max(term.cols, 1), Math.max(term.rows, 1));
      }
      term.refresh(0, Math.max(term.rows - 1, 0));
      term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return <div ref={containerRef} className="docker-exec-term" />;
}

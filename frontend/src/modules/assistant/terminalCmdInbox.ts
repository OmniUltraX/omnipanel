import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ASSISTANT_TERMINAL_OPEN_OR_FOCUS } from "../../ipc/events";
import { openSshTerminalSession } from "../../lib/terminalSession";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { safeTauriUnlisten } from "../../lib/safeTauriUnlisten";
import { useBlocksStore } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { flattenOutputModel } from "../terminal/terminalOutputModel";

export type AssistantTerminalOpenOrFocusPayload = {
  requestId?: string;
  request_id?: string;
  connectionId?: string;
  connection_id?: string;
  op?: string;
};

const RECENT_BLOCK_LIMIT = 20;
const BLOCK_OUTPUT_MAX = 8 * 1024;

let unlisten: UnlistenFn | null = null;
let started = false;

function truncateText(raw: string, max: number): { text: string; truncated: boolean } {
  if (raw.length <= max) return { text: raw, truncated: false };
  let end = max;
  while (end > 0 && raw.codePointAt(end - 1) === undefined) end -= 1;
  // Prefer char boundary
  while (end > 0 && /[\uD800-\uDBFF]/.test(raw[end - 1] ?? "")) end -= 1;
  return { text: `${raw.slice(0, end)}…`, truncated: true };
}

function collectRecentShellBlocks(sessionId: string) {
  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const shell = blocks.filter(
    (b) =>
      (b.kind == null || b.kind === "shell") &&
      !b.directoryPreview &&
      String(b.command || "").trim(),
  );
  const recent = shell.slice(-RECENT_BLOCK_LIMIT);
  return recent.map((b) => {
    const live = b.liveOutput ? flattenOutputModel(b.liveOutput) : "";
    const rawOut = String(b.output || live || "");
    const { text, truncated } = truncateText(rawOut, BLOCK_OUTPUT_MAX);
    return {
      id: b.id,
      command: b.command,
      output: text,
      exitCode: b.exitCode,
      status: b.status,
      timestamp: b.timestamp,
      truncated,
    };
  });
}

async function replyTerminalCmd(payload: {
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}): Promise<void> {
  try {
    await invoke("assistant_terminal_cmd_reply", {
      req: {
        requestId: payload.requestId,
        ok: payload.ok,
        result: payload.result ?? null,
        error: payload.error ?? null,
      },
    });
  } catch (err) {
    console.warn("[assistant-terminal-cmd] reply failed", err);
  }
}

function applyOpenOrFocus(payload: AssistantTerminalOpenOrFocusPayload): void {
  const requestId = String(payload.requestId ?? payload.request_id ?? "").trim();
  const connectionId = String(
    payload.connectionId ?? payload.connection_id ?? "",
  ).trim();

  void (async () => {
    if (!connectionId) {
      console.warn("[assistant-terminal-cmd] 缺少 connectionId", payload);
      if (requestId) {
        await replyTerminalCmd({
          requestId,
          ok: false,
          error: "缺少 connectionId",
        });
      }
      return;
    }

    const before = useTerminalStore
      .getState()
      .listSessionsForResource(connectionId)
      .filter((s) => s.lifecycle !== "ended");
    const hadActive = before.some(
      (s) =>
        s.lifecycle === "active" ||
        useTerminalStore.getState().tabs.some((t) => t.sessionId === s.id),
    );

    const tabId = openSshTerminalSession(connectionId);
    if (!tabId) {
      console.warn("[assistant-terminal-cmd] 无法打开 SSH 会话", connectionId);
      if (requestId) {
        await replyTerminalCmd({
          requestId,
          ok: false,
          error: "无法打开 SSH 会话",
        });
      }
      return;
    }

    const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
    const sessionId = tab?.sessionId || "";
    // 等一帧，让 store / 建连副作用落稳
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const blocks = sessionId ? collectRecentShellBlocks(sessionId) : [];

    console.info("[assistant-terminal-cmd] openOrFocus", {
      connectionId,
      tabId,
      sessionId,
      reused: hadActive,
      blocks: blocks.length,
    });

    if (requestId) {
      await replyTerminalCmd({
        requestId,
        ok: true,
        result: {
          op: "openOrFocus",
          connectionId,
          sessionId,
          tabId,
          reused: hadActive,
          accepted: true,
          blocks,
        },
      });
    }
  })();
}

/** 登录后启动：订阅助手端终端 openOrFocus 命令。 */
export async function startAssistantTerminalCmdInbox(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (started && unlisten) return;

  await stopAssistantTerminalCmdInbox();
  unlisten = await listen<AssistantTerminalOpenOrFocusPayload>(
    ASSISTANT_TERMINAL_OPEN_OR_FOCUS,
    (event) => {
      applyOpenOrFocus(event.payload);
    },
  );
  started = true;
}

export async function stopAssistantTerminalCmdInbox(): Promise<void> {
  started = false;
  safeTauriUnlisten(unlisten);
  unlisten = null;
}

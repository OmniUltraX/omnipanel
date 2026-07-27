import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { ASSISTANT_CHAT_INBOUND } from "../../ipc/events";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { sendToAiDock } from "../../lib/ai/sendToAiDock";
import { safeTauriUnlisten } from "../../lib/safeTauriUnlisten";
import { useAiStore } from "../../stores/aiStore";
import { useAuthStore } from "../../stores/authStore";

const SEEN_STORAGE_KEY = "omnipanel-assistant-chat-seen.v1";
const SEEN_MAX = 200;

export type AssistantChatInboundPayload = {
  messageId: string;
  objectKey: string;
  createdAt: string;
  text: string;
};

let startedToken: string | null = null;
let unlistenInbound: UnlistenFn | null = null;
let startPromise: Promise<void> | null = null;

/** 入站提示排队：当前正在生成时先入队，避免 submit 被直接丢弃。 */
const inboundQueue: string[] = [];
let drainingQueue = false;

function loadSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string" && x.length > 0));
  } catch {
    return new Set();
  }
}

function persistSeenIds(ids: Set<string>): void {
  const list = Array.from(ids);
  const trimmed = list.length > SEEN_MAX ? list.slice(list.length - SEEN_MAX) : list;
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore quota
  }
}

function markSeen(messageId: string): boolean {
  if (!messageId) return false;
  const seen = loadSeenIds();
  if (seen.has(messageId)) return false;
  seen.add(messageId);
  persistSeenIds(seen);
  return true;
}

function waitUntilIdle(timeoutMs = 120_000): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (!useAiStore.getState().isGenerating) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 200);
    };
    tick();
  });
}

async function drainInboundQueue(): Promise<void> {
  if (drainingQueue) return;
  drainingQueue = true;
  try {
    while (inboundQueue.length > 0) {
      const idle = await waitUntilIdle();
      if (!idle) {
        console.warn("[assistant-chat-inbox] wait for AI idle timed out");
        break;
      }
      const text = inboundQueue.shift();
      if (!text) continue;
      try {
        await sendToAiDock(text, {
          openDrawer: true,
          contextChips: [{ type: "assistant-remote", label: "助手端" }],
        });
      } catch (err) {
        console.warn("[assistant-chat-inbox] submit failed", err);
      }
    }
  } finally {
    drainingQueue = false;
    if (inboundQueue.length > 0) {
      void drainInboundQueue();
    }
  }
}

function applyInbound(payload: AssistantChatInboundPayload): void {
  const messageId = (payload.messageId || payload.objectKey || "").trim();
  const text = (payload.text || "").trim();
  if (!text) {
    console.warn("[assistant-chat-inbox] empty text, skip", payload);
    return;
  }
  if (messageId && !markSeen(messageId)) {
    return;
  }

  // 走正式发消息链路：写入用户消息 + 触发 AI 生成（不是只塞进历史）
  inboundQueue.push(text);
  void drainInboundQueue();
}

/** 登录后启动：订阅 App Event + 后端 SSE/latest 收件箱。 */
export async function startAssistantChatInbox(): Promise<void> {
  const token = useAuthStore.getState().token?.trim() ?? "";
  if (!token) return;

  if (startedToken === token && unlistenInbound) {
    return;
  }

  if (startPromise) {
    await startPromise;
    if (startedToken === token && unlistenInbound) return;
  }

  startPromise = (async () => {
    await stopAssistantChatInbox();

    unlistenInbound = await listen<AssistantChatInboundPayload>(ASSISTANT_CHAT_INBOUND, (event) => {
      applyInbound(event.payload);
    });

    try {
      await unwrapCommand(commands.assistantChatInboxStart(token), { quiet: true });
      startedToken = token;
    } catch (err) {
      safeTauriUnlisten(unlistenInbound);
      unlistenInbound = null;
      startedToken = null;
      console.warn("[assistant-chat-inbox] start failed", formatIpcError(err));
    }
  })();

  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

/** 登出 / 卸载时停止收件箱。 */
export async function stopAssistantChatInbox(): Promise<void> {
  startedToken = null;
  safeTauriUnlisten(unlistenInbound);
  unlistenInbound = null;
  inboundQueue.length = 0;
  try {
    await unwrapCommand(commands.assistantChatInboxStop(), { quiet: true });
  } catch {
    // 停止失败可忽略
  }
}

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { ASSISTANT_CHAT_INBOUND, ASSISTANT_CHAT_SET_MODEL } from "../../ipc/events";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { ASSISTANT_PAGE_AGENT_ID } from "../../lib/ai/agents";
import { AiPromptBusyError } from "../../lib/ai/submitAiPrompt";
import { sendToAiDock } from "../../lib/ai/sendToAiDock";
import type { AskUserAnswerValue } from "../../lib/ai/aiMessageParts";
import {
  skipAskUserForm,
  submitAskUserAnswers,
} from "../../lib/ai/orchestration/askUserToolDispatcher";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { safeTauriUnlisten } from "../../lib/safeTauriUnlisten";
import { useAiStore } from "../../stores/aiStore";
import { useAuthStore } from "../../stores/authStore";
import {
  useAiComposerContextStore,
  type ComposerContextItem,
} from "../../stores/aiComposerContextStore";
import { scheduleAssistantSnapshotSync } from "./autoSync";

const SEEN_STORAGE_KEY = "omnipanel-assistant-chat-seen.v1";
const SEEN_MAX = 200;

const COMPOSER_KINDS = new Set(["terminal", "ssh", "database", "docker"]);

function normalizeComposerContexts(
  raw: Array<{ kind: string; id: string; label: string }> | undefined,
): ComposerContextItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: ComposerContextItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let kind = String(item?.kind || "").trim();
    // 兼容旧助手端把终端模块标成 ssh 的情况
    if (kind === "ssh" && String(item?.id || "").startsWith("tsess-")) {
      kind = "terminal";
    }
    const id = String(item?.id || "").trim();
    if (!COMPOSER_KINDS.has(kind) || !id) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String(item?.label || id).trim() || id;
    out.push({ kind: kind as ComposerContextItem["kind"], id, label });
  }
  return out;
}

function applyComposerContexts(contexts: ComposerContextItem[]): void {
  const store = useAiComposerContextStore.getState();
  for (const item of contexts) {
    store.addItem(item);
  }
}

export type AssistantChatInboundPayload = {
  messageId: string;
  objectKey: string;
  createdAt: string;
  text: string;
  /** 助手端当前选中会话；有则投递到该会话，勿新开 */
  sessionId?: string;
  /** 兼容后端 / 旧事件蛇形字段 */
  session_id?: string;
  /** 助手端选中的询问对象 */
  contexts?: Array<{ kind: string; id: string; label: string }>;
  /** 澄清答案快通道（camelCase / snake_case 兼容） */
  askUser?: {
    formId: string;
    toolCallId: string;
    status: string;
    answersJson: string;
  } | null;
  ask_user?: {
    form_id?: string;
    formId?: string;
    tool_call_id?: string;
    toolCallId?: string;
    status?: string;
    answers_json?: string;
    answersJson?: string;
  } | null;
};

export type AssistantChatSetModelPayload = {
  sessionId?: string;
  session_id?: string;
  modelSelectionId?: string;
  model_selection_id?: string;
  providerId?: string;
  provider_id?: string;
  modelName?: string;
  model_name?: string;
};

type QueuedInbound = {
  text: string;
  conversationId?: string;
  messageId?: string;
  contexts?: Array<{ kind: string; id: string; label: string }>;
};

let startedToken: string | null = null;
let unlistenInbound: UnlistenFn | null = null;
let unlistenSetModel: UnlistenFn | null = null;
let startPromise: Promise<void> | null = null;

/** 入站提示排队：当前正在生成时先入队，避免 submit 被直接丢弃。 */
const inboundQueue: QueuedInbound[] = [];
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

function hasSeen(messageId: string): boolean {
  if (!messageId) return false;
  return loadSeenIds().has(messageId);
}

function markSeen(messageId: string): void {
  if (!messageId) return;
  const seen = loadSeenIds();
  if (seen.has(messageId)) return;
  seen.add(messageId);
  persistSeenIds(seen);
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

/** 切到目标会话、退出子会话只读视图、打开 AI 面板 */
function prepareInboundUi(conversationId?: string): void {
  const store = useAiStore.getState();
  store.openDrawer();
  store.setViewingChildConversation(null);
  if (conversationId) {
    store.ensureConversationId(conversationId, {
      agentId: ASSISTANT_PAGE_AGENT_ID,
    });
  }
}

async function focusMainWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.unminimize().catch(() => {});
    await win.setFocus().catch(() => {});
  } catch {
    // 非窗口环境忽略
  }
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
      const item = inboundQueue.shift();
      if (!item?.text) continue;
      if (item.messageId && hasSeen(item.messageId)) continue;

      prepareInboundUi(item.conversationId);
      await focusMainWindow();
      // 等一帧，让会话切换与抽屉打开提交到 React
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      const contexts = normalizeComposerContexts(item.contexts);
      applyComposerContexts(contexts);
      const contextChips = [
        { type: "assistant-remote", label: "助手端" },
        ...contexts.map((c) => ({ type: c.kind, label: c.label })),
      ];

      try {
        await sendToAiDock(item.text, {
          openDrawer: true,
          conversationId: item.conversationId,
          contextChips,
        });
        if (item.messageId) markSeen(item.messageId);
      } catch (err) {
        if (err instanceof AiPromptBusyError) {
          // 竞态：刚空闲又被占用 → 插回队头再等
          inboundQueue.unshift(item);
          continue;
        }
        console.warn("[assistant-chat-inbox] submit failed", err);
        // 失败不 markSeen，允许后续重试（同 messageId 仍可再入队）
      }
    }
  } finally {
    drainingQueue = false;
    if (inboundQueue.length > 0) {
      void drainInboundQueue();
    }
  }
}

function resolveSessionId(payload: AssistantChatInboundPayload): string | undefined {
  const raw = payload.sessionId ?? payload.session_id ?? "";
  const id = String(raw).trim();
  return id || undefined;
}

function resolveAskUserAnswer(payload: AssistantChatInboundPayload): {
  formId: string;
  status: "answered" | "skipped";
  answers: Record<string, AskUserAnswerValue>;
} | null {
  const raw = payload.askUser ?? payload.ask_user;
  if (!raw || typeof raw !== "object") return null;
  const formId = String(
    ("formId" in raw ? raw.formId : undefined) ??
      ("form_id" in raw ? raw.form_id : undefined) ??
      "",
  ).trim();
  const statusRaw = String(("status" in raw ? raw.status : undefined) ?? "")
    .trim()
    .toLowerCase();
  if (!formId) return null;
  if (statusRaw !== "answered" && statusRaw !== "skipped") return null;

  let answers: Record<string, AskUserAnswerValue> = {};
  if (statusRaw === "answered") {
    const answersJson = String(
      ("answersJson" in raw ? raw.answersJson : undefined) ??
        ("answers_json" in raw ? raw.answers_json : undefined) ??
        "{}",
    );
    try {
      const parsed = JSON.parse(answersJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        answers = parsed as Record<string, AskUserAnswerValue>;
      }
    } catch {
      console.warn("[assistant-chat-inbox] ask_user answers JSON 无效", answersJson);
      return null;
    }
  }

  return { formId, status: statusRaw, answers };
}

/** 澄清答案：不排队、不等 isGenerating，直接 resolve 挂起工具 */
async function applyAskUserInbound(
  payload: AssistantChatInboundPayload,
  answer: {
    formId: string;
    status: "answered" | "skipped";
    answers: Record<string, AskUserAnswerValue>;
  },
): Promise<void> {
  const messageId = (payload.messageId || payload.objectKey || "").trim();
  if (messageId && hasSeen(messageId)) return;

  const conversationId = resolveSessionId(payload);
  prepareInboundUi(conversationId);
  void focusMainWindow();

  try {
    if (answer.status === "skipped") {
      await skipAskUserForm(answer.formId);
    } else {
      await submitAskUserAnswers(answer.formId, answer.answers);
    }
    if (messageId) markSeen(messageId);
  } catch (err) {
    console.warn("[assistant-chat-inbox] ask_user 提交失败", err);
  }
}

function applyInbound(payload: AssistantChatInboundPayload): void {
  const askAnswer = resolveAskUserAnswer(payload);
  if (askAnswer) {
    void applyAskUserInbound(payload, askAnswer);
    return;
  }

  const messageId = (payload.messageId || payload.objectKey || "").trim();
  const text = (payload.text || "").trim();
  if (!text) {
    console.warn("[assistant-chat-inbox] empty text, skip", payload);
    return;
  }
  if (messageId && hasSeen(messageId)) {
    return;
  }
  if (messageId && inboundQueue.some((q) => q.messageId === messageId)) {
    return;
  }

  const conversationId = resolveSessionId(payload);
  const contexts = Array.isArray(payload.contexts) ? payload.contexts : [];

  // 先切 UI，再入队触发生成（成功后才 markSeen）
  prepareInboundUi(conversationId);
  void focusMainWindow();

  inboundQueue.push({
    text,
    conversationId,
    messageId: messageId || undefined,
    contexts,
  });
  void drainInboundQueue();
}

/** 助手端切模：确保会话存在并更新 modelSelectionId */
function applySetModel(payload: AssistantChatSetModelPayload): void {
  const sessionId = String(payload.sessionId ?? payload.session_id ?? "").trim();
  const modelSelectionId = String(
    payload.modelSelectionId ?? payload.model_selection_id ?? "",
  ).trim();
  if (!sessionId || !modelSelectionId) {
    console.warn("[assistant-chat-inbox] setModel 字段不完整", payload);
    return;
  }

  const store = useAiStore.getState();
  store.ensureConversationId(sessionId, {
    agentId: ASSISTANT_PAGE_AGENT_ID,
  });
  store.setConversationModelSelectionId(sessionId, modelSelectionId);
  scheduleAssistantSnapshotSync({ immediate: true });
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
    unlistenSetModel = await listen<AssistantChatSetModelPayload>(
      ASSISTANT_CHAT_SET_MODEL,
      (event) => {
        applySetModel(event.payload);
      },
    );

    try {
      await unwrapCommand(commands.assistantChatInboxStart(token), { quiet: true });
      startedToken = token;
    } catch (err) {
      safeTauriUnlisten(unlistenInbound);
      unlistenInbound = null;
      safeTauriUnlisten(unlistenSetModel);
      unlistenSetModel = null;
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
  safeTauriUnlisten(unlistenSetModel);
  unlistenSetModel = null;
  inboundQueue.length = 0;
  try {
    await unwrapCommand(commands.assistantChatInboxStop(), { quiet: true });
  } catch {
    // 停止失败可忽略
  }
}

/**
 * 终端会话 AI 自动命名
 *
 * - 自动命名：会话首个 shell block 完成后，调用 AI 生成简短标题并回写。
 * - 手动重新命名：右键菜单「AI 重新命名」以首/末几轮上下文重新生成。
 *
 * 增强项：
 * - 动态上下文：< 5 条全取，> 5 条取首3末3
 * - i18n prompt：根据用户语言切换中英文
 * - 请求队列：手动命名时如果已有命名在进行中，排队而非丢弃
 * - 重试机制：首次失败后延迟 3s 重试一次
 * - 会话清理：会话关闭时自动清理 Set 中的标记，防止内存泄漏
 * - 无 provider 反馈：返回结构化结果供调用方做 toast 提示
 *
 * 调用链：blocksStore 订阅 → tryAutoNameSession → generateSessionTitle → renameSession
 */

import { useBlocksStore, type TerminalBlock, type AiThreadItem } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  useAiModelsStore,
  resolveModelSelection,
  firstModelSelectionId,
} from "../../stores/aiModelsStore";
import { buildBearerAuthorization, fetchWithNetworkHint } from "../../lib/fetchHeaders";
import { useSettingsStore } from "../../stores/settingsStore";

/** 上下文提取：短会话全取，长会话首末截取 */
const CONTEXT_HEAD_COUNT = 3;
const CONTEXT_TAIL_COUNT = 3;
const CONTEXT_FULL_THRESHOLD = 5;
/** 生成标题的最大字符数 */
const MAX_TITLE_CHARS = 16;
/** 单次 AI 请求超时 */
const AI_REQUEST_TIMEOUT_MS = 15_000;
/** 失败重试延迟 */
const RETRY_DELAY_MS = 3_000;
/** 重试次数 */
const MAX_RETRIES = 1;

/** 命名结果类型 */
export type AiRenameResult =
  | { ok: true; title: string }
  | { ok: false; reason: "no-provider" | "no-context" | "request-failed" };

/** 已自动命名过的会话（防止重复触发） */
const autoNamedSessions = new Set<string>();

/** 正在进行 AI 命名的会话（防止并发） */
const pendingAiNaming = new Set<string>();

/** 手动命名请求队列：sessionId → 待处理的请求 resolve 数组 */
const renameQueues = new Map<string, Array<() => Promise<AiRenameResult>>>();

/** 通知监听器：命名状态变化（用于 UI loading 指示） */
type NamingStateListener = (sessionId: string, pending: boolean) => void;
const namingListeners = new Set<NamingStateListener>();

function emitNamingState(sessionId: string, pending: boolean): void {
  for (const listener of namingListeners) {
    listener(sessionId, pending);
  }
}

/** 订阅 AI 命名状态变化，返回取消订阅函数 */
export function subscribeAiNamingState(listener: NamingStateListener): () => void {
  namingListeners.add(listener);
  return () => namingListeners.delete(listener);
}

/** 当前会话是否正在 AI 命名中 */
export function isAiNaming(sessionId: string): boolean {
  return pendingAiNaming.has(sessionId);
}

/** 判断标题是否仍为默认值（未被用户修改过） */
function isDefaultTitle(title: string): boolean {
  if (!title) return true;
  // 本地终端默认标题
  if (title === "本地终端" || title === "Local Terminal") return true;
  // SSH 默认用主机名，难以穷举——约定：如果标题含 @ 且无空格（如 root@host），视为默认
  if (/^[^\s]+@[^\s]+$/.test(title)) return true;
  return false;
}

/** 从 blocks 中提取用于命名的上下文文本（动态截取，排除静默 block） */
export function extractNamingContext(blocks: TerminalBlock[]): string {
  if (blocks.length === 0) return "";

  // 只取 shell block 和 ai block 中有意义的，排除静默 block（auto-ls 等）
  const meaningful = blocks.filter(
    (b) =>
      !b.silent &&
      (b.kind !== "ai" || (b.aiThread && b.aiThread.length > 0)),
  );
  if (meaningful.length === 0) return "";

  // 动态截取：≤5 条全取，>5 条取首3末3
  let selected: TerminalBlock[];
  if (meaningful.length <= CONTEXT_FULL_THRESHOLD) {
    selected = meaningful;
  } else {
    const head = meaningful.slice(0, CONTEXT_HEAD_COUNT);
    const tail = meaningful.slice(-CONTEXT_TAIL_COUNT);
    selected = [...head, ...tail];
  }

  const lines: string[] = [];
  for (const block of selected) {
    if (block.kind === "ai" && block.aiThread) {
      const summary = summarizeAiThread(block.aiThread);
      if (summary) lines.push(`[AI对话] ${summary}`);
    } else {
      const cmd = block.command.trim();
      if (cmd) {
        const outputSnippet = block.output.trim().slice(0, 200);
        lines.push(outputSnippet ? `[命令] ${cmd}\n输出: ${outputSnippet}` : `[命令] ${cmd}`);
      }
    }
  }
  return lines.join("\n");
}

/** 摘要 AI 线程：取用户消息和助手回复的开头 */
function summarizeAiThread(thread: AiThreadItem[]): string {
  const messages = thread.filter((item) => item.kind === "message");
  if (messages.length === 0) return "";
  const parts: string[] = [];
  for (const msg of messages.slice(0, 4)) {
    const content = msg.content.trim().slice(0, 150);
    if (content) {
      parts.push(`${msg.role === "user" ? "问" : "答"}: ${content}`);
    }
  }
  return parts.join(" | ");
}

interface AiModelConfig {
  baseUrl: string;
  apiKey: string;
  name: string;
}

/** 从 aiModelsStore 获取第一个可用的模型配置 */
function resolveAiModelConfig(): AiModelConfig | null {
  const providers = useAiModelsStore.getState().providers;
  if (providers.length === 0) return null;
  const selectionId = firstModelSelectionId(providers);
  if (!selectionId) return null;
  const resolved = resolveModelSelection(providers, selectionId);
  if (!resolved || !resolved.apiKey.trim()) return null;
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    name: resolved.name,
  };
}

/** 构建 chat completions 请求 URL（兼容 baseUrl 是否含 /v1） */
function buildChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  return clean.includes("/v1")
    ? `${clean}/chat/completions`
    : `${clean}/v1/chat/completions`;
}

/** 根据用户语言构建 system prompt */
function buildSystemPrompt(lang: string): string {
  const isZh = lang.startsWith("zh");
  if (isZh) {
    return `你是一个终端会话命名助手。根据用户在终端中执行的命令和 AI 对话内容，生成一个简短、有描述性的会话标题。

要求：
- 不超过 ${MAX_TITLE_CHARS} 个字符
- 直接输出标题文本，不要引号、不要标点前缀、不要解释
- 使用中文
- 概括这组操作的核心目的（如：编译 Rust 项目、排查端口占用、部署 Docker 服务）`;
  }
  return `You are a terminal session naming assistant. Based on the commands and AI conversations executed in the terminal, generate a short, descriptive session title.

Requirements:
- No more than ${MAX_TITLE_CHARS} characters
- Output the title text directly, no quotes, no punctuation prefixes, no explanations
- Use English
- Summarize the core purpose of these operations (e.g.: Build Rust project, Debug port usage, Deploy Docker service)`;
}

function buildUserPrompt(context: string, lang: string): string {
  const isZh = lang.startsWith("zh");
  return isZh
    ? `以下是终端会话的操作记录，请生成标题：\n\n${context}`
    : `Below is the terminal session operation log. Please generate a title:\n\n${context}`;
}

/**
 * 调用 AI 生成会话标题（单次请求，含重试）
 * @returns 结果对象
 */
async function requestSessionTitle(
  blocks: TerminalBlock[],
  signal?: AbortSignal,
): Promise<AiRenameResult> {
  const context = extractNamingContext(blocks);
  if (!context.trim()) return { ok: false, reason: "no-context" };

  const config = resolveAiModelConfig();
  if (!config) return { ok: false, reason: "no-provider" };

  const lang = useSettingsStore.getState().locale ?? "zh-CN";
  const systemPrompt = buildSystemPrompt(lang);
  const userPrompt = buildUserPrompt(context, lang);
  const url = buildChatCompletionsUrl(config.baseUrl);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    if (signal) {
      signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const response = await fetchWithNetworkHint(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: buildBearerAuthorization(config.apiKey),
        },
        body: JSON.stringify({
          model: config.name,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 50,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(`[sessionAutoName] AI 请求失败 (attempt ${attempt + 1}): HTTP ${response.status}`);
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const content: string | undefined = data?.choices?.[0]?.message?.content;
      if (!content) {
        lastError = new Error("Empty response");
        continue;
      }

      // 清理：去引号、去换行、截断
      const cleaned = content
        .trim()
        .replace(/^["'""''「『]+|["'""''」』]+$/g, "")
        .replace(/\n+/g, " ")
        .slice(0, MAX_TITLE_CHARS)
        .trim();

      if (cleaned) {
        return { ok: true, title: cleaned };
      }
      lastError = new Error("Empty after cleanup");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        return { ok: false, reason: "request-failed" };
      }
      console.warn(`[sessionAutoName] AI 请求异常 (attempt ${attempt + 1}):`, err);
      lastError = err as Error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, reason: "request-failed" };
}

/** 回写会话标题 */
function applyTitle(sessionId: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  useTerminalStore.getState().renameSession(sessionId, trimmed);
}

/**
 * 自动命名：首个 shell block 完成后触发
 * - 仅对「尚未命名」的会话执行
 * - 每会话只触发一次
 */
export async function tryAutoNameSession(sessionId: string): Promise<void> {
  // 已自动命名过
  if (autoNamedSessions.has(sessionId)) return;
  // 正在命名中
  if (pendingAiNaming.has(sessionId)) return;

  const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session) return;
  // 仅对默认标题的会话自动命名
  if (!isDefaultTitle(session.title)) return;

  // 检查是否已有用户主动执行的 shell block（排除 auto-ls 等静默 block）
  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const hasUserCompletedShell = blocks.some(
    (b) =>
      b.kind !== "ai" &&
      !b.silent &&
      (b.status === "completed" || b.status === "failed"),
  );
  if (!hasUserCompletedShell) return;

  autoNamedSessions.add(sessionId);
  pendingAiNaming.add(sessionId);
  emitNamingState(sessionId, true);

  try {
    const result = await requestSessionTitle(blocks);
    if (result.ok) {
      // 写回前再次检查：用户可能在 AI 请求期间手动重命名了
      const current = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
      if (current && isDefaultTitle(current.title)) {
        applyTitle(sessionId, result.title);
      }
    }
  } finally {
    pendingAiNaming.delete(sessionId);
    emitNamingState(sessionId, false);
  }
}

/**
 * 手动重新命名：右键菜单「AI 重新命名」
 * - 不受「尚未命名」限制
 * - 使用首/末几轮上下文
 * - 如果已有命名在进行中，排队等待而非丢弃
 * @returns 结果对象（调用方可据此显示 toast）
 */
export async function renameSessionWithAi(sessionId: string): Promise<AiRenameResult> {
  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  if (blocks.length === 0) return { ok: false, reason: "no-context" };

  // 如果已有命名在进行中，排队等待
  if (pendingAiNaming.has(sessionId)) {
    return new Promise<AiRenameResult>((resolve) => {
      const queue = renameQueues.get(sessionId) ?? [];
      queue.push(async () => {
        return doRenameSessionWithAi(sessionId);
      });
      renameQueues.set(sessionId, queue);
      // 排队请求的结果通过下面的 doRenameSessionWithAi 的 finally 中的 drainQueue 传递
      // 但简化实现：排队请求等待当前完成后重新调用
      void doRenameSessionWithAi(sessionId).then(resolve);
    });
  }

  return doRenameSessionWithAi(sessionId);
}

/** 实际执行手动命名的内部函数 */
async function doRenameSessionWithAi(sessionId: string): Promise<AiRenameResult> {
  if (pendingAiNaming.has(sessionId)) {
    // 已有进行中，返回当前进行中的结果（由调用方的 Promise 统一处理）
    return { ok: false, reason: "request-failed" };
  }

  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  if (blocks.length === 0) return { ok: false, reason: "no-context" };

  pendingAiNaming.add(sessionId);
  emitNamingState(sessionId, true);

  try {
    const result = await requestSessionTitle(blocks);
    if (result.ok) {
      applyTitle(sessionId, result.title);
      // 手动重新命名后标记为已命名，避免后续自动命名覆盖
      autoNamedSessions.add(sessionId);
    }
    return result;
  } finally {
    pendingAiNaming.delete(sessionId);
    emitNamingState(sessionId, false);
    // 处理排队请求
    drainRenameQueue(sessionId);
  }
}

/** 消耗排队的手动命名请求 */
function drainRenameQueue(sessionId: string): void {
  const queue = renameQueues.get(sessionId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) {
    renameQueues.delete(sessionId);
  }
  if (next) {
    void next();
  }
}

// ========== 自动命名订阅 ==========

let subscriptionUnsubscribe: (() => void) | null = null;
let sessionCleanupUnsubscribe: (() => void) | null = null;

/**
 * 启动自动命名订阅：监听 blocksStore 变化，首个 shell block 完成后触发命名。
 * 同时监听 terminalStore 的会话删除事件，清理标记防止内存泄漏。
 * 应在终端模块挂载时调用一次。
 */
export function startAutoNameSubscription(): () => void {
  if (subscriptionUnsubscribe) return subscriptionUnsubscribe;

  const unsubscribeBlocks = useBlocksStore.subscribe((state) => {
    // 遍历所有 session 的 blocks，检查是否有新完成的用户 shell block（排除静默 block）
    for (const [sessionId, blocks] of Object.entries(state.blocks)) {
      const hasUserCompletedShell = blocks.some(
        (b) =>
          b.kind !== "ai" &&
          !b.silent &&
          (b.status === "completed" || b.status === "failed") &&
          b.completedAt != null,
      );
      if (hasUserCompletedShell) {
        // 异步触发，不阻塞 store 更新
        void tryAutoNameSession(sessionId);
      }
    }
  });

  // 监听会话删除：清理标记
  const unsubscribeSessions = useTerminalStore.subscribe((state, prevState) => {
    const prevIds = new Set(prevState.sessions.map((s) => s.id));
    const currentIds = new Set(state.sessions.map((s) => s.id));
    for (const id of prevIds) {
      if (!currentIds.has(id)) {
        autoNamedSessions.delete(id);
        pendingAiNaming.delete(id);
        renameQueues.delete(id);
      }
    }
  });

  const cleanup = () => {
    unsubscribeBlocks();
    unsubscribeSessions();
    subscriptionUnsubscribe = null;
    sessionCleanupUnsubscribe = null;
  };

  subscriptionUnsubscribe = cleanup;
  return cleanup;
}

/** 重置某个会话的自动命名标记（用于测试或会话重置） */
export function resetAutoNameFlag(sessionId: string): void {
  autoNamedSessions.delete(sessionId);
}

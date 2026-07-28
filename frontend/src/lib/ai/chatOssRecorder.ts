import { commands } from "../../ipc/bindings";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

const FLUSH_INTERVAL_MS = 3000;
const NEXT_ID_STORAGE_KEY = "omnipanel-chat-oss-next-id.v2";

/** 分片正文协议：分隔符段落 + 上传前聚合（取代 NDJSON 事件行）。 */
export const CHAT_OSS_FORMAT = "omni-chat-sections.v1" as const;

/** 段落标签（刻意等宽 12 字符对齐）。 */
export const CHAT_OSS_SECTION_TAGS = {
  user: "user_message",
  reasoning: "ai_reasoning",
  content: "ai___message",
  tool_call: "tool_calling",
  tool_result: "tool___result",
  error: "error______",
} as const;

export type ChatOssSectionTag =
  (typeof CHAT_OSS_SECTION_TAGS)[keyof typeof CHAT_OSS_SECTION_TAGS];

export type ChatOssEvent =
  | { t: "user"; text: string }
  | { t: "content"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "tool_call"; id: string; name: string; arguments: string }
  | { t: "tool_result"; id: string; status: string; result?: string }
  | { t: "error"; text: string };

type ToolCallItem = { id: string; name: string; arguments: string };
type ToolResultItem = { id: string; status: string; result?: string };

type AggregatedSection =
  | { kind: "user" | "content" | "reasoning" | "error"; text: string }
  /** 连续并行工具调用聚成一段；`items` 内按 id 去重覆盖，多行 JSON 输出。 */
  | { kind: "tool_call"; items: ToolCallItem[] }
  | { kind: "tool_result"; items: ToolResultItem[] };

type NextIdState = {
  /** 会话 id（conversation / session） */
  sessionId: string;
  /** 下一个要写入的文件编号 */
  nextId: number;
};

function loadNextIdState(sessionId: string): NextIdState {
  try {
    const raw = localStorage.getItem(NEXT_ID_STORAGE_KEY);
    if (!raw) return { sessionId, nextId: 0 };
    const parsed = JSON.parse(raw) as Partial<NextIdState>;
    const storedSession =
      typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const nextId =
      typeof parsed.nextId === "number" && Number.isFinite(parsed.nextId) && parsed.nextId >= 0
        ? Math.floor(parsed.nextId)
        : 0;
    if (storedSession !== sessionId) {
      return { sessionId, nextId: 0 };
    }
    return { sessionId, nextId };
  } catch {
    return { sessionId, nextId: 0 };
  }
}

function saveNextIdState(state: NextIdState): void {
  try {
    localStorage.setItem(NEXT_ID_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private mode
  }
}

function allocateNextFileId(sessionId: string): number {
  const state = loadNextIdState(sessionId);
  const id = state.nextId;
  saveNextIdState({ sessionId, nextId: id + 1 });
  return id;
}

/** 避免 sessionId 含路径分隔符导致目录逃逸。 */
function sanitizeSessionDir(sessionId: string): string {
  const cleaned = sessionId.trim().replace(/[/\\]+/g, "_");
  return cleaned || "unknown-session";
}

/** 拼出 OSS object key：`{oss_path}/{sessionId}/{n}.txt`（posix；桶名由后端剥离）。 */
export function buildChatOssObjectKey(
  ossPath: string,
  sessionId: string,
  fileId: number,
): string {
  const base = ossPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const session = sanitizeSessionDir(sessionId);
  if (!base) {
    return `${session}/${fileId}.txt`;
  }
  return `${base}/${session}/${fileId}.txt`;
}

function isEmptyEvent(event: ChatOssEvent): boolean {
  switch (event.t) {
    case "user":
    case "content":
    case "reasoning":
    case "error":
      return !event.text;
    case "tool_call":
      return !event.id.trim() || !event.name.trim();
    case "tool_result":
      return !event.id.trim();
    default:
      return true;
  }
}

function sectionTagFor(kind: AggregatedSection["kind"]): ChatOssSectionTag {
  return CHAT_OSS_SECTION_TAGS[kind];
}

/** 单段：分隔符 + 正文。 */
export function encodeChatOssSection(tag: ChatOssSectionTag, body: string): string {
  const text = body.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  return `\n----------------\n|[${tag}]|\n----------------\n${text ? `${text}\n` : ""}`;
}

function sectionBody(section: AggregatedSection): string {
  switch (section.kind) {
    case "user":
    case "content":
    case "reasoning":
    case "error":
      return section.text;
    case "tool_call":
      return section.items
        .map((item) =>
          JSON.stringify({
            id: item.id,
            name: item.name,
            arguments: item.arguments,
          }),
        )
        .join("\n");
    case "tool_result":
      return section.items
        .map((item) => {
          const payload: { id: string; status: string; result?: string } = {
            id: item.id,
            status: item.status,
          };
          if (item.result !== undefined) payload.result = item.result;
          return JSON.stringify(payload);
        })
        .join("\n");
    default:
      return "";
  }
}

/** 将聚合后的段落编码为分片正文（不含头注释）。 */
export function encodeChatOssSections(sections: AggregatedSection[]): string {
  if (sections.length === 0) return "";
  return sections
    .map((s) => encodeChatOssSection(sectionTagFor(s.kind), sectionBody(s)))
    .join("");
}

function upsertToolCallItems(
  items: ToolCallItem[],
  item: ToolCallItem,
): ToolCallItem[] {
  const idx = items.findIndex((x) => x.id === item.id);
  if (idx >= 0) {
    const next = items.slice();
    next[idx] = item;
    return next;
  }
  return [...items, item];
}

function upsertToolResultItems(
  items: ToolResultItem[],
  item: ToolResultItem,
): ToolResultItem[] {
  const idx = items.findIndex((x) => x.id === item.id);
  if (idx >= 0) {
    const next = items.slice();
    next[idx] = item;
    return next;
  }
  return [...items, item];
}

/**
 * 将流事件并入聚合列表：
 * - 同类型文本拼接
 * - 连续 tool_* 并入同一 section；同 id 覆盖，不同 id 追加为多行 JSON
 * 导出供单测验证。
 */
export function aggregateChatOssEvent(
  sections: AggregatedSection[],
  event: ChatOssEvent,
): AggregatedSection[] {
  if (isEmptyEvent(event)) return sections;
  const next = sections.slice();
  const last = next[next.length - 1];

  switch (event.t) {
    case "user":
    case "content":
    case "reasoning":
    case "error": {
      if (last && last.kind === event.t) {
        next[next.length - 1] = { ...last, text: last.text + event.text };
      } else {
        next.push({ kind: event.t, text: event.text });
      }
      return next;
    }
    case "tool_call": {
      const item: ToolCallItem = {
        id: event.id,
        name: event.name,
        arguments: event.arguments,
      };
      if (last && last.kind === "tool_call") {
        next[next.length - 1] = {
          kind: "tool_call",
          items: upsertToolCallItems(last.items, item),
        };
      } else {
        next.push({ kind: "tool_call", items: [item] });
      }
      return next;
    }
    case "tool_result": {
      const item: ToolResultItem = {
        id: event.id,
        status: event.status,
        result: event.result,
      };
      if (last && last.kind === "tool_result") {
        next[next.length - 1] = {
          kind: "tool_result",
          items: upsertToolResultItems(last.items, item),
        };
      } else {
        next.push({ kind: "tool_result", items: [item] });
      }
      return next;
    }
    default:
      return next;
  }
}

class ChatOssSession {
  /** 自上次 flush 以来聚合的段落。 */
  private sections: AggregatedSection[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly sessionDir: string;
  private readonly ossPath: string;
  private readonly conversationId: string;

  constructor(ossPath: string, conversationId: string) {
    this.ossPath = ossPath;
    this.conversationId = conversationId;
    this.sessionDir = sanitizeSessionDir(conversationId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.enqueueFlush();
    }, FLUSH_INTERVAL_MS);
  }

  appendEvent(event: ChatOssEvent): void {
    this.sections = aggregateChatOssEvent(this.sections, event);
  }

  private enqueueFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.flushOnce()).catch(() => {});
    return this.flushChain;
  }

  private async flushOnce(): Promise<void> {
    if (this.sections.length === 0) return;
    const snapshot = this.sections;
    this.sections = [];

    const token = useAuthStore.getState().token?.trim() ?? "";
    if (!token) {
      // 未登录无法申请 STS：塞回缓冲，下次间隔再试
      this.sections = [...snapshot, ...this.sections];
      console.warn("[chat-oss] skip upload: not logged in");
      return;
    }

    const fileId = allocateNextFileId(this.sessionDir);
    const objectKey = buildChatOssObjectKey(this.ossPath, this.sessionDir, fileId);
    const body = encodeChatOssSections(snapshot);
    const payload = [
      `# conversation=${this.conversationId}`,
      `# written_at=${new Date().toISOString()}`,
      `# file_id=${fileId}`,
      `# format=${CHAT_OSS_FORMAT}`,
      body.replace(/^\n/, ""),
    ].join("\n");

    try {
      const res = await commands.assistantUploadOssText({
        token,
        objectKey,
        contents: payload,
      });
      if (res.status !== "ok") {
        // 上传失败时把内容塞回缓冲，避免丢数据；下次间隔再试
        this.sections = [...snapshot, ...this.sections];
        // 回滚编号，避免跳号留下空洞
        saveNextIdState({ sessionId: this.sessionDir, nextId: fileId });
        console.warn("[chat-oss] upload failed:", res.error);
      }
    } catch (error) {
      this.sections = [...snapshot, ...this.sections];
      saveNextIdState({ sessionId: this.sessionDir, nextId: fileId });
      console.warn("[chat-oss] upload error:", error);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.enqueueFlush();
  }
}

let activeSession: ChatOssSession | null = null;

/** 若 /api/me 返回了 oss_path，则在模型流式输出期间每 3s 经 STS 上传一次。 */
export function startChatOssRecording(conversationId: string): void {
  const ossPath = useUserProfileStore.getState().ossPath.trim();
  if (!ossPath) return;
  void stopChatOssRecording();
  activeSession = new ChatOssSession(ossPath, conversationId);
  activeSession.start();
}

/** 追加一条结构化流事件（上传前会聚合为分隔符段落）。 */
export function appendChatOssEvent(event: ChatOssEvent): void {
  activeSession?.appendEvent(event);
}

/** @deprecated 使用 appendChatOssEvent；保留兼容，一律当作 content。 */
export function appendChatOssChunk(chunk: string): void {
  if (!chunk) return;
  appendChatOssEvent({ t: "content", text: chunk });
}

/** 结束本轮生成：刷新剩余缓冲并释放会话。 */
export async function stopChatOssRecording(): Promise<void> {
  const session = activeSession;
  activeSession = null;
  if (session) {
    await session.stop();
  }
}

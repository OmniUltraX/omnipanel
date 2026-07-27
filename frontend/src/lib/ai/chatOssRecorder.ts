import { commands } from "../../ipc/bindings";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

const FLUSH_INTERVAL_MS = 5000;
const NEXT_ID_STORAGE_KEY = "omnipanel-chat-oss-next-id.v2";

/** 分片正文协议版本（助手端按此解析 NDJSON 事件行）。 */
export const CHAT_OSS_FORMAT = "omni-chat-events.v1" as const;

export type ChatOssEvent =
  | { t: "user"; text: string }
  | { t: "content"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "tool_call"; id: string; name: string; arguments: string }
  | { t: "tool_result"; id: string; status: string; result?: string }
  | { t: "error"; text: string };

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

/** 将一条流事件编码为单行 NDJSON（含 v 字段）。 */
export function encodeChatOssEventLine(event: ChatOssEvent): string {
  const base = { v: 1 as const, ...event };
  return JSON.stringify(base);
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

class ChatOssSession {
  private buffer = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly sessionDir: string;

  constructor(
    private readonly ossPath: string,
    private readonly conversationId: string,
  ) {
    this.sessionDir = sanitizeSessionDir(conversationId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.enqueueFlush();
    }, FLUSH_INTERVAL_MS);
  }

  appendEvent(event: ChatOssEvent): void {
    if (isEmptyEvent(event)) return;
    this.buffer += `${encodeChatOssEventLine(event)}\n`;
  }

  private enqueueFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.flushOnce()).catch(() => {});
    return this.flushChain;
  }

  private async flushOnce(): Promise<void> {
    const content = this.buffer;
    if (!content) return;
    this.buffer = "";

    const token = useAuthStore.getState().token?.trim() ?? "";
    if (!token) {
      // 未登录无法申请 STS：塞回缓冲，下次间隔再试
      this.buffer = content + this.buffer;
      console.warn("[chat-oss] skip upload: not logged in");
      return;
    }

    const fileId = allocateNextFileId(this.sessionDir);
    const objectKey = buildChatOssObjectKey(this.ossPath, this.sessionDir, fileId);
    const payload = [
      `# conversation=${this.conversationId}`,
      `# written_at=${new Date().toISOString()}`,
      `# file_id=${fileId}`,
      `# format=${CHAT_OSS_FORMAT}`,
      "",
      content.replace(/\n$/, ""),
    ].join("\n");

    try {
      const res = await commands.assistantUploadOssText({
        token,
        objectKey,
        contents: payload,
      });
      if (res.status !== "ok") {
        // 上传失败时把内容塞回缓冲，避免丢数据；下次间隔再试
        this.buffer = content + this.buffer;
        // 回滚编号，避免跳号留下空洞
        saveNextIdState({ sessionId: this.sessionDir, nextId: fileId });
        console.warn("[chat-oss] upload failed:", res.error);
      }
    } catch (error) {
      this.buffer = content + this.buffer;
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

/** 若 /api/me 返回了 oss_path，则在模型流式输出期间每 5s 经 STS 上传一次。 */
export function startChatOssRecording(conversationId: string): void {
  const ossPath = useUserProfileStore.getState().ossPath.trim();
  if (!ossPath) return;
  void stopChatOssRecording();
  activeSession = new ChatOssSession(ossPath, conversationId);
  activeSession.start();
}

/** 追加一条结构化流事件（content / reasoning / tool_*）。 */
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

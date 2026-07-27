import { commands } from "../../ipc/bindings";
import { useUserProfileStore } from "../../stores/userProfileStore";

const FLUSH_INTERVAL_MS = 5000;
const NEXT_ID_STORAGE_KEY = "omnipanel-chat-oss-next-id.v2";

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

function joinPath(root: string, ...parts: string[]): string {
  const trimmedRoot = root.replace(/[/\\]+$/, "");
  const sep = /\\/.test(trimmedRoot) && !/\//.test(trimmedRoot) ? "\\" : "/";
  return [trimmedRoot, ...parts.map((p) => p.replace(/^[/\\]+|[/\\]+$/g, ""))].join(sep);
}

/** 避免 sessionId 含路径分隔符导致目录逃逸。 */
function sanitizeSessionDir(sessionId: string): string {
  const cleaned = sessionId.trim().replace(/[/\\]+/g, "_");
  return cleaned || "unknown-session";
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

  append(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
  }

  private enqueueFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.flushOnce()).catch(() => {});
    return this.flushChain;
  }

  private async flushOnce(): Promise<void> {
    const content = this.buffer;
    if (!content) return;
    this.buffer = "";

    const fileId = allocateNextFileId(this.sessionDir);
    const path = joinPath(this.ossPath, this.sessionDir, `${fileId}.txt`);
    const payload = [
      `# conversation=${this.conversationId}`,
      `# written_at=${new Date().toISOString()}`,
      `# file_id=${fileId}`,
      "",
      content,
    ].join("\n");

    try {
      const res = await commands.writeTextFile(path, payload);
      if (res.status !== "ok") {
        // 写失败时把内容塞回缓冲，避免丢数据；下次间隔再试
        this.buffer = content + this.buffer;
        console.warn("[chat-oss] write failed:", res.error);
      }
    } catch (error) {
      this.buffer = content + this.buffer;
      console.warn("[chat-oss] write error:", error);
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

/** 若 /api/me 返回了 oss_path，则在模型流式输出期间每 5s 落盘一次。 */
export function startChatOssRecording(conversationId: string): void {
  const ossPath = useUserProfileStore.getState().ossPath.trim();
  if (!ossPath) return;
  void stopChatOssRecording();
  activeSession = new ChatOssSession(ossPath, conversationId);
  activeSession.start();
}

/** 追加模型返回的正文 / 推理文本。 */
export function appendChatOssChunk(chunk: string): void {
  activeSession?.append(chunk);
}

/** 结束本轮生成：刷新剩余缓冲并释放会话。 */
export async function stopChatOssRecording(): Promise<void> {
  const session = activeSession;
  activeSession = null;
  if (session) {
    await session.stop();
  }
}

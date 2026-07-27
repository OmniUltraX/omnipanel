import { commands } from "../../ipc/bindings";
import { useUserProfileStore } from "../../stores/userProfileStore";

const FLUSH_INTERVAL_MS = 5000;
const NEXT_ID_STORAGE_KEY = "omnipanel-chat-oss-next-id.v1";

type NextIdState = {
  /** yyyyMMdd */
  date: string;
  /** 下一个要写入的文件编号 */
  nextId: number;
};

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function loadNextIdState(): NextIdState {
  const today = todayYmd();
  try {
    const raw = localStorage.getItem(NEXT_ID_STORAGE_KEY);
    if (!raw) return { date: today, nextId: 0 };
    const parsed = JSON.parse(raw) as Partial<NextIdState>;
    const date = typeof parsed.date === "string" ? parsed.date : today;
    const nextId =
      typeof parsed.nextId === "number" && Number.isFinite(parsed.nextId) && parsed.nextId >= 0
        ? Math.floor(parsed.nextId)
        : 0;
    if (date !== today) {
      return { date: today, nextId: 0 };
    }
    return { date, nextId };
  } catch {
    return { date: today, nextId: 0 };
  }
}

function saveNextIdState(state: NextIdState): void {
  try {
    localStorage.setItem(NEXT_ID_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private mode
  }
}

function allocateNextFileId(): number {
  const state = loadNextIdState();
  const id = state.nextId;
  saveNextIdState({ date: state.date, nextId: id + 1 });
  return id;
}

function joinPath(root: string, ...parts: string[]): string {
  const trimmedRoot = root.replace(/[/\\]+$/, "");
  const sep = /\\/.test(trimmedRoot) && !/\//.test(trimmedRoot) ? "\\" : "/";
  return [trimmedRoot, ...parts.map((p) => p.replace(/^[/\\]+|[/\\]+$/g, ""))].join(sep);
}

class ChatOssSession {
  private buffer = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ossPath: string,
    private readonly conversationId: string,
  ) {}

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

    const date = todayYmd();
    // 跨日时重置编号
    const idState = loadNextIdState();
    if (idState.date !== date) {
      saveNextIdState({ date, nextId: 0 });
    }
    const fileId = allocateNextFileId();
    const path = joinPath(this.ossPath, date, `${fileId}.txt`);
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

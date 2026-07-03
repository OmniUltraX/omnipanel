import { useBlocksStore } from "../../stores/blocksStore";

type PendingChunk = {
  content: string;
  reasoning: string;
};

const pendingByKey = new Map<string, PendingChunk>();
const dirtyKeys = new Set<string>();
let flushRaf = 0;

function streamKey(blockId: string, messageId: string): string {
  return `${blockId}\0${messageId}`;
}

function flushKey(key: string): void {
  const pending = pendingByKey.get(key);
  if (!pending) return;

  const sep = key.indexOf("\0");
  const blockId = key.slice(0, sep);
  const messageId = key.slice(sep + 1);
  const store = useBlocksStore.getState();

  if (pending.content) {
    store.appendAiThreadMessageFieldSync(blockId, messageId, "content", pending.content);
  }
  if (pending.reasoning) {
    store.appendAiThreadMessageFieldSync(blockId, messageId, "reasoning", pending.reasoning);
  }

  pendingByKey.delete(key);
  dirtyKeys.delete(key);
}

function scheduleFlush(): void {
  if (flushRaf) return;
  flushRaf = requestAnimationFrame(() => {
    flushRaf = 0;
    for (const key of dirtyKeys) {
      flushKey(key);
    }
  });
}

/** 终端内联 AI 流式 chunk：合并到下一帧写入 store，避免每 token 触发整页重渲染 */
export function appendInlineAiStreamChunk(
  blockId: string,
  messageId: string,
  field: "content" | "reasoning",
  chunk: string,
): void {
  if (!chunk) return;
  const key = streamKey(blockId, messageId);
  let pending = pendingByKey.get(key);
  if (!pending) {
    pending = { content: "", reasoning: "" };
    pendingByKey.set(key, pending);
  }
  pending[field] += chunk;
  dirtyKeys.add(key);
  scheduleFlush();
}

/** 流式结束或中断前立即刷入剩余 chunk */
export function flushInlineAiStream(blockId: string, messageId?: string): void {
  if (flushRaf) {
    cancelAnimationFrame(flushRaf);
    flushRaf = 0;
  }

  if (messageId) {
    flushKey(streamKey(blockId, messageId));
    return;
  }

  for (const key of [...pendingByKey.keys()]) {
    if (key.startsWith(`${blockId}\0`)) {
      flushKey(key);
    }
  }
}

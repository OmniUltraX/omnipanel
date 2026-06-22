/** 合并同一帧内多次 terminal-output，减少 base64 解码与 xterm.write 次数。 */

type FlushHandler = (merged: Uint8Array) => void;

interface TerminalOutputBatcher {
  push: (chunk: Uint8Array) => void;
  flush: () => void;
  dispose: () => void;
}

export function createTerminalOutputBatcher(onFlush: FlushHandler): TerminalOutputBatcher {
  const chunks: Uint8Array[] = [];
  let rafId: number | null = null;
  let totalBytes = 0;

  const flush = () => {
    rafId = null;
    if (chunks.length === 0) return;
    if (chunks.length === 1) {
      onFlush(chunks[0]!);
      chunks.length = 0;
      totalBytes = 0;
      return;
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
    totalBytes = 0;
    onFlush(merged);
  };

  const scheduleFlush = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(flush);
  };

  return {
    push(chunk: Uint8Array) {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      totalBytes += chunk.length;
      scheduleFlush();
    },
    flush,
    dispose() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      chunks.length = 0;
      totalBytes = 0;
    },
  };
}

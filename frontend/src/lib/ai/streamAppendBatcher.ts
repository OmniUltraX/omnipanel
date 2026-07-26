/**
 * 将高频流式 append 合并到下一帧，降低 Zustand/React 重渲染频率，改善体感流畅度。
 */
export type StreamAppendFlush = (content: string, reasoning: string) => void;

export function createStreamAppendBatcher(flush: StreamAppendFlush) {
  let content = "";
  let reasoning = "";
  let raf = 0;

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!content && !reasoning) return;
      const c = content;
      const r = reasoning;
      content = "";
      reasoning = "";
      flush(c, r);
    });
  };

  return {
    appendContent(chunk: string) {
      if (!chunk) return;
      content += chunk;
      schedule();
    },
    appendReasoning(chunk: string) {
      if (!chunk) return;
      reasoning += chunk;
      schedule();
    },
    /** 同步刷出缓冲（结束/取消/错误前必须调用）。 */
    flushNow() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!content && !reasoning) return;
      const c = content;
      const r = reasoning;
      content = "";
      reasoning = "";
      flush(c, r);
    },
  };
}

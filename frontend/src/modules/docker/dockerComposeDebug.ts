const PREFIX = "[docker-compose]";

/** 本地墙钟 HH:mm:ss.SSS，便于对照控制台先后顺序 */
function formatWallClock(date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * 是否输出 Compose 调试日志：
 * - 开发模式默认开
 * - 或 localStorage.setItem("omnipanel.debug.dockerCompose", "1") 强制开（生产包也可）
 *
 * 注意：用 console.info，不用 console.debug——Chrome/WebView 默认隐藏 Verbose，debug 看不到。
 */
function isComposeDebugEnabled(): boolean {
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage?.getItem("omnipanel.debug.dockerCompose") === "1") {
        return true;
      }
    } catch {
      // ignore storage access errors
    }
  }
  return Boolean(import.meta.env.DEV);
}

/**
 * 输出 Compose 调试信息（墙钟时间 + 可选分段耗时）。
 */
export function debugCompose(message: string, data?: Record<string, unknown>): void {
  if (!isComposeDebugEnabled()) return;
  const at = formatWallClock();
  if (data !== undefined) {
    console.info(PREFIX, at, message, data);
    return;
  }
  console.info(PREFIX, at, message);
}

export type ComposeDebugSpan = {
  /** 相对 span 起点的毫秒数 */
  elapsedMs: () => number;
  /** 记录一步；附带 elapsedMs（自开始）与 stepMs（自上一步） */
  step: (name: string, data?: Record<string, unknown>) => void;
  /** 结束 span，返回总耗时 ms */
  end: (name?: string, data?: Record<string, unknown>) => number;
};

/** 打开一段计时：用于定位 loadFiles / IPC 哪一步慢 */
export function beginComposeDebug(
  label: string,
  data?: Record<string, unknown>,
): ComposeDebugSpan {
  const t0 = performance.now();
  let last = t0;
  debugCompose(`${label} · 开始`, {
    ...data,
    elapsedMs: 0,
    stepMs: 0,
  });
  return {
    elapsedMs: () => Math.round(performance.now() - t0),
    step(name, extra) {
      const now = performance.now();
      const stepMs = Math.round(now - last);
      last = now;
      debugCompose(`${label} · ${name}`, {
        ...extra,
        elapsedMs: Math.round(now - t0),
        stepMs,
      });
    },
    end(name = "结束", extra) {
      const now = performance.now();
      const totalMs = Math.round(now - t0);
      const stepMs = Math.round(now - last);
      last = now;
      debugCompose(`${label} · ${name}`, {
        ...extra,
        elapsedMs: totalMs,
        stepMs,
        totalMs,
      });
      return totalMs;
    },
  };
}

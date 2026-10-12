import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/**
 * 把 xterm 的行列同步给 PTY。
 * 只监听容器元素尺寸会漏掉字体加载和 WebGL 测量：格子变高后 top/vim 仍按旧行数画。
 * 容器还没展开时不要 fit，避免把 2×1 发给 PTY。
 */
export function bindPtyFit(
  term: Terminal,
  fitAddon: FitAddon,
  mount: HTMLElement,
  resize: (cols: number, rows: number) => void,
): { dispose: () => void; publishCurrentSize: () => void } {
  let disposed = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  function canFit(): boolean {
    const rect = mount.getBoundingClientRect();
    return rect.width >= 40 && rect.height >= 40;
  }

  function fit(): void {
    if (disposed || !canFit()) return;
    fitAddon.fit();
  }

  function schedule(cols: number, rows: number): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (disposed || cols < 2 || rows < 1) return;
      resize(cols, rows);
    }, 100);
  }

  const onResize = term.onResize(({ cols, rows }) => {
    schedule(cols, rows);
  });

  fit();
  void document.fonts?.ready.then(() => {
    fit();
  });

  const observer = new ResizeObserver(() => {
    fit();
  });
  observer.observe(mount);

  return {
    publishCurrentSize() {
      schedule(term.cols, term.rows);
    },
    dispose() {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      onResize.dispose();
      observer.disconnect();
    },
  };
}

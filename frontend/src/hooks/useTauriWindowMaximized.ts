import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { safeTauriUnlisten } from "../lib/safeTauriUnlisten";
import { isTauriRuntime } from "../lib/isTauriRuntime";

/** 订阅 Tauri 窗口最大化状态；onResized 回调必须同步，async 会导致 unhandledrejection */
export function useTauriWindowMaximized(enabled = true): boolean {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // 纯浏览器（vite dev 直开）没有 Tauri 运行时，getCurrentWindow 会抛错
    if (!enabled || !isTauriRuntime()) return;

    const win = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void | Promise<void>) | undefined;

    const refresh = () => {
      void win
        .isMaximized()
        .then((maximized) => {
          if (alive) setIsMaximized(maximized);
        })
        .catch(() => undefined);
    };

    refresh();
    void win
      .onResized(() => {
        refresh();
      })
      .then((fn) => {
        if (!alive) {
          safeTauriUnlisten(fn);
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      alive = false;
      safeTauriUnlisten(unlisten);
      unlisten = undefined;
    };
  }, [enabled]);

  return isMaximized;
}

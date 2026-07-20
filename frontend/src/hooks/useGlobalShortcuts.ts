/**
 * 集中式全局快捷键调度器。
 *
 * 取代分散的 useXxxShortcut hooks，在一个 keydown 监听里统一分发：
 * - close-tab / switch-tab / switch-nth-tab：按当前焦点 dock 智能分发
 * - new-terminal / new-ssh：全局动作
 * - search-terminal：委托给 scopedSearchRegistry（若焦点在已注册 scope）
 * - split-vertical / split-horizontal：终端分屏（预留，暂未实现 dockview split）
 *
 * 已有的 toggle-ai / open-settings / toggle-bottom-workspace / format-sql 等
 * 保留各自独立 hook（它们的触发条件与焦点强相关，集中化反而增加复杂度）。
 *
 * 焦点 dock 判断基于 statusBarActionBarStore.activeDock.dockScope。
 */

import { useEffect } from "react";
import { getShortcutKeys, matchesShortcut } from "../stores/shortcutsStore";
import { useStatusBarActionBarStore } from "../stores/statusBarActionBarStore";
import {
  getDockviewInstanceByScope,
  findDockviewInstanceContainingElement,
} from "../lib/dockviewRegistry";
import { openLocalTerminalSession } from "../lib/terminalSession";
import { useCommandRegistry } from "../stores/commandRegistry";
import { useTerminalStore } from "../stores/terminalStore";
import { clearAllSessionBlocks } from "../modules/terminal/terminalBlockActions";

/** dockScope 前缀 → 模块标识，用于 tab 操作智能分发 */
const SCOPE_PREFIX_TO_MODULE: Record<string, string> = {
  database: "database",
  terminal: "terminal",
  "protocol-http": "protocol",
  "workspace-bottom-": "workspace-bottom",
};

function resolveModuleFromScope(dockScope: string | undefined): string | null {
  if (!dockScope) return null;
  for (const [prefix, mod] of Object.entries(SCOPE_PREFIX_TO_MODULE)) {
    if (dockScope.startsWith(prefix)) return mod;
  }
  return null;
}

/** 解析当前应响应 Tab 快捷键的 dockview 实例 */
function resolveFocusedDockInstance() {
  const { activeDock } = useStatusBarActionBarStore.getState();
  if (activeDock?.dockScope) {
    const byScope = getDockviewInstanceByScope(activeDock.dockScope);
    if (byScope) return byScope;
  }
  // 状态栏未同步时：从焦点元素所属 dock 回退
  return findDockviewInstanceContainingElement(document.activeElement) ?? null;
}

/** 在焦点 dock 上执行 tab 操作（close / switch / nth） */
function actOnFocusedDock(
  action: "close" | "next" | "prev" | "nth",
  n?: number,
): boolean {
  const instance = resolveFocusedDockInstance();
  if (!instance) return false;
  const api = instance.api;
  const panels = api.panels;
  if (panels.length === 0) return false;

  if (action === "close") {
    const active = api.activePanel;
    if (!active) return false;
    try {
      active.api.close();
      return true;
    } catch {
      return false;
    }
  }

  if (action === "next" || action === "prev") {
    const active = api.activePanel;
    const idx = active ? panels.indexOf(active) : -1;
    if (idx === -1) {
      panels[0]?.api.setActive();
      return true;
    }
    const dir = action === "next" ? 1 : -1;
    const next = (idx + dir + panels.length) % panels.length;
    panels[next]?.api.setActive();
    return true;
  }

  if (action === "nth" && typeof n === "number") {
    // Mod+1..9 → index 0..8
    const panel = panels[n - 1];
    if (!panel) return false;
    panel.api.setActive();
    return true;
  }

  return false;
}

/** 尝试执行命令注册表里某 shortcutId 对应的命令（如果存在） */
function tryRunCommandByShortcutId(shortcutId: string): boolean {
  const cmds = useCommandRegistry.getState().commands;
  for (const cmd of Object.values(cmds)) {
    if (cmd.shortcutId === shortcutId) {
      cmd.run();
      return true;
    }
  }
  return false;
}

/**
 * 检测双击 Shift（Search Everywhere 触发）。
 *
 * 必须用「轻触」语义（keydown → 短按 → keyup），不能只数 keydown：
 * 长按 Shift 时浏览器会自动重复 keydown（e.repeat），容易在窗口内误判为双击。
 */
function useDoubleShiftTrigger(onTrigger: () => void) {
  const DOUBLE_SHIFT_MS = 350;
  /** 单次按住超过此时间视为长按，不算 tap */
  const MAX_TAP_HOLD_MS = 400;

  useEffect(() => {
    let lastTapAt = 0;
    let shiftDownAt = 0;
    /** Shift 按住期间按了其它键（组合键/输入），本次不算 tap */
    let contaminated = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        // 忽略长按产生的自动重复
        if (e.repeat) return;
        shiftDownAt = Date.now();
        contaminated = false;
        return;
      }
      if (shiftDownAt > 0) {
        contaminated = true;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const target = e.target as HTMLElement;
      if (target?.closest?.(".xterm")) return;

      const downAt = shiftDownAt;
      shiftDownAt = 0;
      if (downAt === 0 || contaminated) {
        contaminated = false;
        return;
      }

      // 长按松开：不算一次 tap
      if (Date.now() - downAt > MAX_TAP_HOLD_MS) return;

      const now = Date.now();
      if (now - lastTapAt < DOUBLE_SHIFT_MS) {
        e.preventDefault();
        e.stopPropagation();
        lastTapAt = 0; // 防止三连 Shift 再次触发
        onTrigger();
      } else {
        lastTapAt = now;
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
  }, [onTrigger]);
}

export { useDoubleShiftTrigger };

/**
 * 集中式全局快捷键调度器。在 App 根组件挂载一次即可。
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 忽略 xterm 内的快捷键（终端有自己的键绑定，除了已被各 hook 捕获阶段的处理）
      const target = e.target as HTMLElement;
      const inXterm = !!target?.closest?.(".xterm");

      // close-tab：Mod+W
      if (matchesShortcut(e, getShortcutKeys("close-tab"))) {
        if (inXterm) return; // 终端 xterm 内不拦截 Mod+W（让终端自己处理）
        if (actOnFocusedDock("close")) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // switch-tab：Mod+Tab / Mod+PageDown
      if (matchesShortcut(e, getShortcutKeys("switch-tab"))) {
        if (actOnFocusedDock("next")) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // switch-tab-prev：Mod+Shift+Tab / Mod+PageUp
      if (matchesShortcut(e, getShortcutKeys("switch-tab-prev"))) {
        if (actOnFocusedDock("prev")) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // switch-nth-tab：Mod+1..9
      const switchNthKeys = getShortcutKeys("switch-nth-tab");
      if (switchNthKeys.length > 0) {
        // switch-nth-tab 定义为 ["Mod", "1-9"]，匹配 Mod+数字
        if (e.code?.startsWith("Digit") && matchesShortcut(e, [["Mod", e.code]])) {
          const n = parseInt(e.code.slice(5), 10);
          if (n >= 1 && n <= 9) {
            if (actOnFocusedDock("nth", n)) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
        }
      }

      // new-terminal：Mod+T（优先走命令注册表，回退到直接调用）
      if (matchesShortcut(e, getShortcutKeys("new-terminal"))) {
        if (inXterm) return;
        if (tryRunCommandByShortcutId("new-terminal")) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        openLocalTerminalSession();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // new-ssh：Mod+N
      if (matchesShortcut(e, getShortcutKeys("new-ssh"))) {
        if (tryRunCommandByShortcutId("new-ssh")) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // 回退：触发命令面板的 new-ssh 导航
        const cmd = useCommandRegistry.getState().commands["new-ssh"];
        if (cmd) {
          cmd.run();
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // search-terminal：Mod+F —— 委托给 scopedSearchRegistry（它自己有监听）
      // 这里不做处理，避免与 scopedSearchRegistry 的捕获阶段监听冲突。
      // scopedSearchRegistry 在焦点/hover 在注册 scope 时已处理 Ctrl+F。
      // 若未来需要"无焦点时 Mod+F 弹全局搜索"，在此扩展。

      // ─── 终端专属快捷键（仅在焦点 dock 为终端时生效） ───────────────
      const focusedModule = resolveModuleFromScope(
        useStatusBarActionBarStore.getState().activeDock?.dockScope,
      );
      if (focusedModule === "terminal") {
        const termStore = useTerminalStore.getState();
        const activeTabId = termStore.activeTabId;
        const activeTab = activeTabId
          ? termStore.tabs.find((t) => t.id === activeTabId)
          : null;
        const sessionId = activeTab?.sessionId;

        // clear-terminal：Ctrl+L / Ctrl+Shift+K
        if (matchesShortcut(e, getShortcutKeys("clear-terminal"))) {
          if (sessionId) {
            clearAllSessionBlocks(sessionId);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }

        // rename-tab：F2
        if (matchesShortcut(e, getShortcutKeys("rename-tab"))) {
          if (activeTabId) {
            window.dispatchEvent(
              new CustomEvent("omnipanel-terminal-rename-tab", {
                detail: { tabId: activeTabId },
              }),
            );
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }

        // scroll-terminal-top：Ctrl+Home
        if (matchesShortcut(e, getShortcutKeys("scroll-terminal-top"))) {
          if (sessionId) {
            window.dispatchEvent(
              new CustomEvent("omnipanel-terminal-scroll", {
                detail: { sessionId, to: "top" },
              }),
            );
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }

        // scroll-terminal-bottom：Ctrl+End
        if (matchesShortcut(e, getShortcutKeys("scroll-terminal-bottom"))) {
          if (sessionId) {
            window.dispatchEvent(
              new CustomEvent("omnipanel-terminal-scroll", {
                detail: { sessionId, to: "bottom" },
              }),
            );
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }

      // split-vertical / split-horizontal：终端分屏（预留，暂未实现 dockview split）
      // 此处占位，等终端 split 功能实现后接入
    };

    // 使用捕获阶段，优先于各模块自己的 bubble 阶段监听
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
}

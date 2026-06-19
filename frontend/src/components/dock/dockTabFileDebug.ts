import type { DockableTab } from "./dockableTab";

const STORAGE_KEY = "omnipanel:debug:dock-tab-file";

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return import.meta.env.DEV;
}

let bootLogged = false;

/** 开发环境默认开启；`localStorage.setItem('omnipanel:debug:dock-tab-file','0')` 关闭，`'1'` 强制开启 */
export function logDockTabFile(stage: string, payload: Record<string, unknown>): void {
  if (!isEnabled()) return;
  if (!bootLogged) {
    bootLogged = true;
    console.info(
      "[DockTabFile] 调试已开启（开发环境默认）。关闭：localStorage.setItem('omnipanel:debug:dock-tab-file','0')",
    );
  }
  console.debug(`[DockTabFile:${stage}]`, payload);
}

export function summarizeFileDockTabs(tabs: DockableTab[]) {
  return tabs
    .filter((tab) => tab.type === "file" || tab.icon === "sql")
    .map((tab) => ({
      id: tab.id,
      label: tab.label,
      type: tab.type,
      dirty: tab.dirty,
      saved: tab.saved,
    }));
}

if (typeof window !== "undefined") {
  (window as Window & { __dockTabFileDebug?: { enable: () => void; disable: () => void } }).__dockTabFileDebug =
    {
      enable: () => localStorage.setItem(STORAGE_KEY, "1"),
      disable: () => localStorage.setItem(STORAGE_KEY, "0"),
    };
}

import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./isTauriRuntime";
import {
  clearWindowHiddenToTray,
  getRecentTrayHiddenLabel,
  getTrayHiddenLabels,
} from "./trayHiddenWindows";

export const SYSTEM_TRAY_ID = "omnipanel-main-tray";

let initPromise: Promise<void> | null = null;

async function showWindowByLabel(label: string): Promise<boolean> {
  try {
    const windows = await getAllWindows();
    const win = windows.find((w) => w.label === label);
    if (!win) return false;
    await win.show();
    await win.unminimize();
    await win.setFocus();
    clearWindowHiddenToTray(label);
    return true;
  } catch (e) {
    console.warn("[systemTray] showWindowByLabel failed", label, e);
    return false;
  }
}

async function showRecentTrayWindow(): Promise<void> {
  const recent = getRecentTrayHiddenLabel();
  if (recent && (await showWindowByLabel(recent))) return;

  const hidden = getTrayHiddenLabels();
  for (let i = hidden.length - 1; i >= 0; i -= 1) {
    const label = hidden[i];
    if (label && (await showWindowByLabel(label))) return;
  }

  // 兜底：显示主窗口
  try {
    const windows = await getAllWindows();
    const main = windows.find((w) => w.label === "main") ?? getCurrentWindow();
    await main.show();
    await main.unminimize();
    await main.setFocus();
  } catch (e) {
    console.warn("[systemTray] showRecent fallback failed", e);
  }
}

async function showAllWindows(): Promise<void> {
  try {
    const windows = await getAllWindows();
    for (const win of windows) {
      try {
        await win.show();
        await win.unminimize();
        clearWindowHiddenToTray(win.label);
      } catch {
        /* ignore single window */
      }
    }
    const main = windows.find((w) => w.label === "main");
    if (main) await main.setFocus();
  } catch (e) {
    console.warn("[systemTray] showAllWindows failed", e);
  }
}

async function quitFromTray(): Promise<void> {
  try {
    await invoke("close_all_workspace_windows");
  } catch {
    /* ignore */
  }
  try {
    await invoke("app_exit");
  } catch (e) {
    console.error("[systemTray] app_exit failed", e);
  }
}

/**
 * 确保整应用只有一个托盘图标。仅应在主窗口调用；若已存在同 id 托盘则复用。
 */
export async function ensureSystemTray(labels: {
  tooltip: string;
  showAll: string;
  quit: string;
}): Promise<void> {
  if (!isTauriRuntime()) return;
  if (getCurrentWindow().label !== "main") return;

  if (!initPromise) {
    initPromise = (async () => {
      const existing = await TrayIcon.getById(SYSTEM_TRAY_ID);
      if (existing) return;

      const menu = await Menu.new({
        items: [
          {
            id: "show-all",
            text: labels.showAll,
            action: () => {
              void showAllWindows();
            },
          },
          {
            id: "quit",
            text: labels.quit,
            action: () => {
              void quitFromTray();
            },
          },
        ],
      });

      let icon: Awaited<ReturnType<typeof defaultWindowIcon>> = null;
      try {
        icon = await defaultWindowIcon();
      } catch (e) {
        console.warn("[systemTray] defaultWindowIcon unavailable, tray will use platform default", e);
      }

      await TrayIcon.new({
        id: SYSTEM_TRAY_ID,
        icon: icon ?? undefined,
        tooltip: labels.tooltip,
        menu,
        showMenuOnLeftClick: false,
        action: (event) => {
          if (event.type === "Click" && event.button === "Left" && event.buttonState === "Up") {
            void showRecentTrayWindow();
          }
        },
      });
    })().catch((e) => {
      initPromise = null;
      console.error("[systemTray] init failed", e);
    });
  }

  await initPromise;
}

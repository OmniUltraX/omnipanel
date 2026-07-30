import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu, Submenu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./isTauriRuntime";
import {
  clearWindowHiddenToTray,
  getRecentTrayHiddenLabel,
  getTrayHiddenLabels,
} from "./trayHiddenWindows";
import { QUICK_LAUNCHER_LABEL, showQuickLauncher } from "./quickLauncher";
import { openModuleWindow, SUPPORTED_MODULE_KEYS } from "./moduleWindow";
import { getNavVisibleModuleKeys } from "../stores/appModuleStore";
import type { ModuleKey } from "./paths";

export const SYSTEM_TRAY_ID = "omnipanel-main-tray";

/** 与侧栏 nav / util 顺序一致；ssh 末尾兜底 */
const TRAY_MODULE_ORDER: readonly ModuleKey[] = [
  "terminal",
  "database",
  "docker",
  "server",
  "files",
  "protocol",
  "workflow",
  "knowledge",
  "tasks",
  "ssh",
];

let initPromise: Promise<void> | null = null;

export type SystemTrayLabels = {
  tooltip: string;
  showAll: string;
  quit: string;
  quickOpen: string;
  /** 子菜单标题，如「打开模块窗口」 */
  openModules: string;
  /** 各模块显示名 */
  moduleLabels: Partial<Record<ModuleKey, string>>;
};

function resolveTrayModuleKeys(): ModuleKey[] {
  const supported = new Set<string>(SUPPORTED_MODULE_KEYS);
  const visible = new Set(getNavVisibleModuleKeys());
  return TRAY_MODULE_ORDER.filter((key) => supported.has(key) && visible.has(key));
}

async function showWindowByLabel(label: string): Promise<boolean> {
  if (label === QUICK_LAUNCHER_LABEL) return false;
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

/** 显示并聚焦主窗口（托盘双击入口）。 */
async function showMainWindow(): Promise<void> {
  if (await showWindowByLabel("main")) return;
  try {
    const windows = await getAllWindows();
    const main = windows.find((w) => w.label === "main") ?? getCurrentWindow();
    await main.show();
    await main.unminimize();
    await main.setFocus();
    clearWindowHiddenToTray(main.label);
  } catch (e) {
    console.warn("[systemTray] showMainWindow failed", e);
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
  await showMainWindow();
}

async function showAllWindows(): Promise<void> {
  try {
    const windows = await getAllWindows();
    for (const win of windows) {
      if (win.label === QUICK_LAUNCHER_LABEL) continue;
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

async function buildModuleWindowsSubmenu(labels: SystemTrayLabels): Promise<Submenu> {
  const keys = resolveTrayModuleKeys();
  const items = keys.map((moduleKey) => ({
    id: `open-module-${moduleKey}`,
    text: labels.moduleLabels[moduleKey] ?? moduleKey,
    action: () => {
      const title = labels.moduleLabels[moduleKey] ?? moduleKey;
      void openModuleWindow(moduleKey, title);
    },
  }));

  return Submenu.new({
    id: "open-module-windows",
    text: labels.openModules,
    items:
      items.length > 0
        ? items
        : [
            {
              id: "open-module-empty",
              text: "—",
              enabled: false,
            },
          ],
  });
}

/**
 * 确保整应用只有一个托盘图标。仅应在主窗口调用；若已存在同 id 托盘则复用。
 */
export async function ensureSystemTray(labels: SystemTrayLabels): Promise<void> {
  if (!isTauriRuntime()) return;
  if (getCurrentWindow().label !== "main") return;

  if (!initPromise) {
    initPromise = (async () => {
      const existing = await TrayIcon.getById(SYSTEM_TRAY_ID);
      if (existing) return;

      const modulesSubmenu = await buildModuleWindowsSubmenu(labels);

      const menu = await Menu.new({
        items: [
          {
            id: "quick-open",
            text: labels.quickOpen,
            action: () => {
              void showQuickLauncher();
            },
          },
          modulesSubmenu,
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
          // 双击：始终打开主窗口
          if (event.type === "DoubleClick" && event.button === "Left") {
            void showMainWindow();
            return;
          }
          // 单击：恢复最近托盘隐藏的窗口（无则主窗）
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

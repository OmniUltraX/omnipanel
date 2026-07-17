import { invoke } from "@tauri-apps/api/core";
import type { SerializedDockview } from "dockview-core";
import {
  useWorkspaceBottomDockStore,
  type WorkspaceDockTab,
} from "../stores/workspaceBottomDockStore";
import {
  useTerminalStore,
  type TerminalTab,
} from "../stores/terminalStore";
import type { TerminalTabSnapshot } from "../stores/workspaceTabStore";
import type { WorkspaceInfo } from "../stores/workspaceStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import {
  useSettingsStore,
  type AccentColor,
  type Locale,
  type Theme,
  type UiDensity,
} from "../stores/settingsStore";
import { ensureTerminalTabFromSnapshot } from "./workspaceTabActions";
import {
  collectAllTabStatesForHandoff,
  applyTabStatePayload,
  type TabStatePayload,
} from "./tabStateTransfer";

const HANDOFF_TTL_MS = 300_000;

export type WorkspaceWindowHandoffKind = "open" | "close";

interface TerminalHandoffEntry {
  id: string;
  label: string;
  sessionType: TerminalTabSnapshot["sessionType"];
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  backendSessionId: string | null;
}

export interface WorkspaceWindowDockHandoff {
  tabs: WorkspaceDockTab[];
  layout: SerializedDockview | null;
  activeTabId: string | null;
}

export interface WorkspaceWindowSettingsHandoff {
  theme: Theme;
  accentColor: AccentColor;
  locale: Locale;
  uiScale: number;
  uiDensity: UiDensity;
}

export interface WorkspaceWindowHandoff {
  workspaceId: string;
  kind: WorkspaceWindowHandoffKind;
  createdAt: number;
  terminals: TerminalHandoffEntry[];
  dock?: WorkspaceWindowDockHandoff;
  workspaces?: WorkspaceInfo[];
  settings?: WorkspaceWindowSettingsHandoff;
  /** 所有 tab 的运行时状态切片（终端历史、SQL 等），按 panelId 索引 */
  tabStates?: Record<string, TabStatePayload>;
}

function terminalTabToHandoff(tab: TerminalTab): TerminalHandoffEntry {
  return {
    id: tab.id,
    label: tab.title,
    sessionType: tab.session.type,
    resourceId: tab.session.resourceId ?? "local-terminal",
    shellLabel: tab.session.shellLabel ?? "",
    cwd: tab.session.cwd ?? "",
    purpose: tab.session.purpose ?? "",
    backendSessionId: tab.backendSessionId ?? null,
  };
}

function collectTerminalIdsFromDockTabs(tabs: WorkspaceDockTab[]): string[] {
  const ids: string[] = [];
  for (const tab of tabs) {
    if (tab.kind === "payload" && tab.payload?.module === "terminal") {
      ids.push(tab.payload.id);
      continue;
    }
    if (tab.kind === "mirrored" && tab.originScope === "terminal" && tab.originPanelId) {
      const raw = tab.originPanelId;
      const payloadPrefix = "ws-payload:terminal:";
      if (raw.startsWith(payloadPrefix)) {
        ids.push(raw.slice(payloadPrefix.length));
      } else if (raw.includes(":")) {
        ids.push(raw.slice(raw.lastIndexOf(":") + 1));
      } else {
        ids.push(raw);
      }
    }
  }
  return [...new Set(ids)];
}

function collectTerminalHandoff(workspaceId: string): TerminalHandoffEntry[] {
  const dockTabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];
  const terminalIds = collectTerminalIdsFromDockTabs(dockTabs);
  const terminalStore = useTerminalStore.getState();
  const terminals: TerminalHandoffEntry[] = [];

  for (const id of terminalIds) {
    const tab = terminalStore.tabs.find((item) => item.id === id);
    if (tab) {
      terminals.push(terminalTabToHandoff(tab));
      continue;
    }
    const payloadTab = dockTabs.find(
      (item) => item.kind === "payload" && item.payload?.module === "terminal" && item.payload.id === id,
    );
    if (payloadTab?.payload?.module === "terminal") {
      const snap = payloadTab.payload;
      terminals.push({
        id: snap.id,
        label: snap.label,
        sessionType: snap.sessionType,
        resourceId: snap.resourceId,
        shellLabel: snap.shellLabel,
        cwd: snap.cwd,
        purpose: snap.purpose,
        backendSessionId: null,
      });
    }
  }
  return terminals;
}

function collectDockHandoff(workspaceId: string): WorkspaceWindowDockHandoff {
  const dock = useWorkspaceBottomDockStore.getState();
  return {
    tabs: dock.tabsByWorkspace[workspaceId] ?? [],
    layout: dock.layoutByWorkspace[workspaceId] ?? null,
    activeTabId: dock.activeTabByWorkspace[workspaceId] ?? null,
  };
}

function collectSettingsHandoff(): WorkspaceWindowSettingsHandoff {
  const s = useSettingsStore.getState();
  return {
    theme: s.theme,
    accentColor: s.accentColor,
    locale: s.locale,
    uiScale: s.uiScale,
    uiDensity: s.uiDensity,
  };
}

async function buildHandoff(
  workspaceId: string,
  kind: WorkspaceWindowHandoffKind,
): Promise<WorkspaceWindowHandoff> {
  const tabStates = await collectAllTabStatesForHandoff(workspaceId);
  return {
    workspaceId,
    kind,
    createdAt: Date.now(),
    terminals: collectTerminalHandoff(workspaceId),
    dock: collectDockHandoff(workspaceId),
    workspaces: useWorkspaceStore.getState().workspaces,
    settings: collectSettingsHandoff(),
    tabStates: Object.keys(tabStates).length > 0 ? tabStates : undefined,
  };
}

/**
 * 构建 handoff JSON（由 Rust 写入 app_data 文件；子窗独立 data_directory 无法读主窗 localStorage）。
 */
export async function buildWorkspaceWindowHandoffJson(
  workspaceId: string,
): Promise<string | null> {
  try {
    return JSON.stringify(await buildHandoff(workspaceId, "open"));
  } catch (e) {
    console.error("[workspaceWindowHandoff] 序列化失败", e);
    return null;
  }
}

export async function buildWorkspaceWindowCloseHandoffJson(
  workspaceId: string,
): Promise<string | null> {
  try {
    return JSON.stringify(await buildHandoff(workspaceId, "close"));
  } catch (e) {
    console.error("[workspaceWindowHandoff] 关闭 handoff 序列化失败", e);
    return null;
  }
}

/**
 * 主窗口弹出独立窗口前：同步内存状态（handoff 文件由 open_workspace_window 写入）。
 */
export async function prepareWorkspaceWindowHandoff(workspaceId: string): Promise<void> {
  await buildWorkspaceWindowHandoffJson(workspaceId);
}

async function writeHandoffToFile(workspaceId: string, json: string): Promise<void> {
  await invoke("write_workspace_window_handoff", { workspaceId, handoffJson: json });
}

export async function writeWorkspaceWindowCloseHandoff(workspaceId: string): Promise<void> {
  const json = await buildWorkspaceWindowCloseHandoffJson(workspaceId);
  if (!json) return;
  await writeHandoffToFile(workspaceId, json);
}

async function readHandoffFromFile(
  workspaceId: string,
  expectedKind?: WorkspaceWindowHandoffKind,
): Promise<WorkspaceWindowHandoff | null> {
  try {
    const raw = await invoke<string | null>("read_workspace_window_handoff", {
      workspaceId,
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceWindowHandoff;
    if (!parsed || parsed.workspaceId !== workspaceId) return null;
    if (expectedKind && parsed.kind !== expectedKind) return null;
    if (Date.now() - (parsed.createdAt ?? 0) > HANDOFF_TTL_MS) {
      await invoke("clear_workspace_window_handoff", { workspaceId }).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function applySettingsHandoff(settings: WorkspaceWindowSettingsHandoff | undefined): void {
  if (!settings) return;
  const store = useSettingsStore.getState();
  store.setTheme(settings.theme);
  store.setAccentColor(settings.accentColor);
  store.setLocale(settings.locale);
  store.setUiScale(settings.uiScale);
  store.setUiDensity(settings.uiDensity);
}

function applyWorkspacesHandoff(
  workspaces: WorkspaceInfo[] | undefined,
  workspaceId: string,
): void {
  if (workspaces?.length) {
    useWorkspaceStore.setState({ workspaces });
  }
  useWorkspaceStore.getState().switchWorkspace(workspaceId);
}

function applyDockHandoff(
  workspaceId: string,
  dock: WorkspaceWindowDockHandoff | undefined,
): void {
  if (!dock) return;
  useWorkspaceBottomDockStore.setState((state) => ({
    tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: dock.tabs },
    layoutByWorkspace: { ...state.layoutByWorkspace, [workspaceId]: dock.layout },
    activeTabByWorkspace: {
      ...state.activeTabByWorkspace,
      [workspaceId]: dock.activeTabId ?? "",
    },
  }));
}

function hydrateTerminalsFromHandoff(
  workspaceId: string,
  handoff: WorkspaceWindowHandoff | null,
): void {
  const dockTabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];
  const terminalIds = collectTerminalIdsFromDockTabs(dockTabs);
  const handoffById = new Map((handoff?.terminals ?? []).map((t) => [t.id, t]));

  for (const id of terminalIds) {
    const entry = handoffById.get(id);
    const snapshot: TerminalTabSnapshot = entry
      ? {
          module: "terminal",
          id: entry.id,
          label: entry.label,
          sessionType: entry.sessionType,
          resourceId: entry.resourceId,
          shellLabel: entry.shellLabel,
          cwd: entry.cwd,
          purpose: entry.purpose,
        }
      : (() => {
          const payloadTab = dockTabs.find(
            (item) =>
              item.kind === "payload" &&
              item.payload?.module === "terminal" &&
              item.payload.id === id,
          );
          if (payloadTab?.payload?.module === "terminal") return payloadTab.payload;
          return {
            module: "terminal",
            id,
            label: id,
            sessionType: "local",
            resourceId: "local-terminal",
            shellLabel: "Shell",
            cwd: "~/",
            purpose: "",
          } satisfies TerminalTabSnapshot;
        })();

    ensureTerminalTabFromSnapshot(snapshot);
    if (entry?.backendSessionId) {
      useTerminalStore.getState().setBackendSessionId(id, entry.backendSessionId);
    }
  }
}

async function clearHandoffFile(workspaceId: string): Promise<void> {
  try {
    await invoke("clear_workspace_window_handoff", { workspaceId });
  } catch {
    // ignore
  }
}

/**
 * 应用 handoff 中的 tab 运行时状态（终端历史、SQL 等）。
 * 各 payload 写入不同 sessionId / dbTabId 的 store 切片，互不依赖，可并行应用。
 */
async function applyTabStatesHandoff(
  tabStates: Record<string, TabStatePayload> | undefined,
): Promise<void> {
  if (!tabStates) return;
  const payloads = Object.values(tabStates);
  if (payloads.length === 0) return;
  // 串行 + 让帧：避免多会话同时 loadSession/replaceSessionBlocks 卡住开窗动画
  for (const payload of payloads) {
    await applyTabStatePayload(payload);
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }
}

/**
 * 独立窗口启动：从 handoff 水合主题、工作区列表、dock 与终端。
 * handoff 缺失（刷新）时仍从 dock + SQLite 恢复终端时间线。
 */
export async function hydrateWorkspaceWindowFromHandoff(workspaceId: string): Promise<void> {
  const handoff = await readHandoffFromFile(workspaceId, "open");
  applySettingsHandoff(handoff?.settings);
  applyWorkspacesHandoff(handoff?.workspaces, workspaceId);
  applyDockHandoff(workspaceId, handoff?.dock);
  hydrateTerminalsFromHandoff(workspaceId, handoff);
  await applyTabStatesHandoff(handoff?.tabStates);
  // handoff 已清或仅含 running 时，其余块从共享 SQLite 冷灌入
  await restoreTerminalHistoryFromSqlite(workspaceId);
  await clearHandoffFile(workspaceId);
}

/** 按工作区 dock 中的终端 session，从 SQLite 恢复 Blocks（已有 live 块则跳过） */
async function restoreTerminalHistoryFromSqlite(workspaceId: string): Promise<void> {
  const dockTabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];
  const terminalIds = collectTerminalIdsFromDockTabs(dockTabs);
  const sessionIds = [
    ...new Set(
      terminalIds.map((id) => {
        const tab = useTerminalStore.getState().tabs.find((t) => t.id === id);
        return tab?.sessionId ?? id;
      }),
    ),
  ].filter(Boolean);
  if (sessionIds.length === 0) return;

  const { bootstrapTerminalHistory } = await import("../modules/terminal/terminalHistorySync");
  bootstrapTerminalHistory(sessionIds);
  // bootstrap 内部异步；对当前活跃会话再显式 await，减少首屏空白
  const { useTerminalHistoryStore } = await import("../stores/terminalHistoryStore");
  const active =
    useTerminalStore.getState().activeSessionId ??
    useTerminalStore.getState().activeTabId ??
    sessionIds[0];
  if (active && sessionIds.includes(active)) {
    await useTerminalHistoryStore.getState().restoreSession(active);
  }
}

/** @deprecated 使用 hydrateWorkspaceWindowFromHandoff */
export async function hydrateWorkspaceWindowTerminals(workspaceId: string): Promise<void> {
  await hydrateWorkspaceWindowFromHandoff(workspaceId);
}

/**
 * 主窗口：独立窗口关闭后收回 dock / 终端状态。
 *
 * 分两阶段执行以避免 UI 空白闪烁：
 * - Phase 1（阻塞）：读 handoff 文件 + applyDockHandoff + hydrateTerminalsFromHandoff
 *   恢复 tab 列表和终端会话。完成后调用 onDockReady，调用方在此切换 UI 到全屏。
 * - Phase 2（后台）：applyTabStatesHandoff（终端历史等）+ clearHandoffFile
 *   不阻塞 UI，用户已能看到正确的 tab 列表。
 *
 * 无论 Phase 1 是否抛错（handoff 文件损坏、JSON parse 失败等），onDockReady 都会被调用，
 * 确保 CLOSED 事件 handler 的 UI 切换不会因 handoff 应用失败而永久卡死。
 */
export async function applyWorkspaceWindowReturnHandoff(
  workspaceId: string,
  onDockReady?: () => void,
): Promise<void> {
  let dockReady = false;
  try {
    const handoff = await readHandoffFromFile(workspaceId, "close");
    if (!handoff) {
      // handoff 文件不存在（窗口被强杀等），让 UI 正常切换
      onDockReady?.();
      dockReady = true;
      return;
    }
    applyDockHandoff(workspaceId, handoff.dock);
    hydrateTerminalsFromHandoff(workspaceId, handoff);
    // dock tabs 和终端会话已恢复，通知调用方可以切 UI 了
    onDockReady?.();
    dockReady = true;
    // tab 运行时状态（历史等）异步恢复，不阻塞 UI
    await applyTabStatesHandoff(handoff?.tabStates);
    await restoreTerminalHistoryFromSqlite(workspaceId);
    await clearHandoffFile(workspaceId);
  } catch (err) {
    console.error(`[handoff] applyWorkspaceWindowReturnHandoff(${workspaceId}) failed:`, err);
  } finally {
    // Phase 1 抛错时 onDockReady 尚未被调用，兜底调用确保 UI 切换不会永久卡死
    if (!dockReady) onDockReady?.();
  }
}

import type { ContextMenuItem } from "../components/ui/ContextMenu";
import type { WorkspaceInfo } from "../stores/workspaceStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type {
  WorkspaceTabSnapshot,
  TerminalTabSnapshot,
  DbTabSnapshot,
  DockerTabSnapshot,
} from "../stores/workspaceTabStore";
import { useWorkspaceBottomDockStore } from "../stores/workspaceBottomDockStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { useTerminalStore } from "../stores/terminalStore";
import type { TerminalTab } from "../stores/terminalStore";
import type { DbWorkspaceTab } from "../modules/database/workspaceTabs";

// --- Snapshot factories ---

export function terminalTabToSnapshot(tab: TerminalTab): TerminalTabSnapshot {
  return {
    module: "terminal",
    id: tab.id,
    label: tab.title,
    sessionType: tab.session.type,
    resourceId: tab.session.resourceId,
    shellLabel: tab.session.shellLabel,
    cwd: tab.session.cwd,
    purpose: tab.session.purpose,
  };
}

export function dbTabToSnapshot(
  tab: DbWorkspaceTab,
  tabMode?: "data" | "sql",
): DbTabSnapshot {
  return {
    module: "database",
    id: tab.id,
    label: tab.label,
    tab,
    tabMode,
  };
}

export function dockerTabToSnapshot(
  subTab: "logs" | "terminal",
  connectionId: string,
  containerId: string,
  containerName: string,
): DockerTabSnapshot {
  return {
    module: "docker",
    id: `docker:${subTab}:${containerId}`,
    label: `${containerName} · ${subTab === "logs" ? "日志" : "终端"}`,
    subTab,
    connectionId,
    containerId,
    containerName,
  };
}

/** 工作区 Dock 中 payload 面板的稳定 id */
export function payloadDockTabId(snapshot: WorkspaceTabSnapshot): string {
  return `ws-payload:${snapshot.module}:${snapshot.id}`;
}

/** 确保终端 store 中存在快照对应的 Tab，供工作区 payload 渲染 */
export function ensureTerminalTabFromSnapshot(snapshot: TerminalTabSnapshot): string {
  const store = useTerminalStore.getState();
  const existing = store.tabs.find((tab) => tab.id === snapshot.id);
  if (existing) return existing.id;
  store.addTab({
    id: snapshot.id,
    title: snapshot.label,
    session: {
      type: snapshot.sessionType,
      resourceId: snapshot.resourceId,
      shellLabel: snapshot.shellLabel,
      cwd: snapshot.cwd,
      purpose: snapshot.purpose,
      commandPack: [],
    },
  });
  return snapshot.id;
}

function resolveWorkspaceInfo(workspaceId: string): WorkspaceInfo | null {
  return (
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId) ?? null
  );
}

/**
 * 统一入口：将来源快照物化为工程工作区 Dock Tab。
 *
 * 注意：这里不写 workspaceTabStore。workspaceTabStore 只保留给终端/数据库
 * 模块自身在“切换工作区”时恢复模块内 Tab，避免 Dock Tab 和模块 Tab 状态串台。
 */
export function addSnapshotToWorkspace(
  workspaceId: string,
  snapshot: WorkspaceTabSnapshot,
  options?: { activate?: boolean },
): void {
  const workspace = resolveWorkspaceInfo(workspaceId);
  if (!workspace) return;

  const dockStore = useWorkspaceBottomDockStore.getState();
  dockStore.ensureWorkspaceData(workspaceId, workspace);
  dockStore.addPayloadTab(workspaceId, workspace, {
    id: payloadDockTabId(snapshot),
    label: snapshot.label,
    payload: snapshot,
    panelType: snapshot.module,
  });

  const currentId = useWorkspaceStore.getState().workspace.id;
  if (workspaceId === currentId) {
    if (options?.activate !== false) {
      useBottomPanelStore.getState().requestExpand();
    }
  }
}

// --- Menu builder ---

export interface AddToWorkspaceMenuOptions {
  /** 当前工作区列表 */
  workspaces: WorkspaceInfo[];
  /** 当前工作区 ID */
  currentWorkspaceId: string;
  /** 要操作的快照 */
  snapshot: WorkspaceTabSnapshot;
  /** 复制到当前工作区时：直接创建 tab（各模块自行实现） */
  onCopyToCurrent?: () => void;
  /** 移动到其他工作区后：关闭原 tab（各模块自行实现） */
  onMoveToOther?: () => void;
}

/**
 * 构建「复制到工作区」子菜单项。
 * - 当前工作区 → 直接调用 onCopyToCurrent 创建 tab
 * - 其他工作区 → 存 snapshot 并物化为 Dock Tab
 */
export function buildCopyToWorkspaceMenuItems(
  options: AddToWorkspaceMenuOptions,
): ContextMenuItem[] {
  const { workspaces, currentWorkspaceId, snapshot, onCopyToCurrent } = options;

  return workspaces.map((ws) => {
    const isCurrent = ws.id === currentWorkspaceId;
    return {
      id: `ws-copy-${ws.id}`,
      label: ws.name + (isCurrent ? " ✓" : ""),
      onClick: () => {
        if (isCurrent) {
          onCopyToCurrent?.();
        } else {
          addSnapshotToWorkspace(ws.id, snapshot);
        }
      },
    };
  });
}

/**
 * 构建「移动到工作区」子菜单项。
 * - 当前工作区 → 不显示（移动到自己没意义）
 * - 其他工作区 → 存 snapshot + 物化 + 关闭原 tab
 */
export function buildMoveToWorkspaceMenuItems(
  t: (key: string) => string,
  options: AddToWorkspaceMenuOptions,
): ContextMenuItem[] {
  const { workspaces, currentWorkspaceId, snapshot, onMoveToOther } = options;

  const otherWorkspaces = workspaces.filter((w) => w.id !== currentWorkspaceId);
  if (otherWorkspaces.length === 0) {
    return [{ id: "ws-move-empty", label: t("shell.workspace.noOther"), disabled: true, separator: false }];
  }

  return otherWorkspaces.map((ws) => ({
    id: `ws-move-${ws.id}`,
    label: ws.name,
    onClick: () => {
      addSnapshotToWorkspace(ws.id, snapshot);
      onMoveToOther?.();
    },
  }));
}

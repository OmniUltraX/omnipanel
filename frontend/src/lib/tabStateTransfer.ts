import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "./isTauriRuntime";

const TAB_STATE_TRANSFER_EVENT = "omnipanel:tab-state-transfer";

export interface TabStatePayload {
  /** 源窗口 label */
  sourceLabel: string;
  /** 目标窗口 label */
  targetLabel: string;
  /** tab 的 panelId（源 dockview 中的 panelId） */
  panelId: string;
  /** 模块类型 */
  module: "terminal" | "database";
  /** 终端 sessionId（仅 module=terminal 时有值） */
  sessionId?: string;
  /** 数据库 tabId（目标窗口 store 中的 key，仅 module=database 时有值） */
  dbTabId?: string;
  /** 终端历史 blocks（已序列化，marker=null） */
  terminalHistory?: unknown[];
  /** shell 命令历史 */
  shellHistory?: { commands: string[]; syncedAt: number };
  /** 内存中的 blocks（已序列化，marker=null） */
  blocks?: unknown[];
  /** DB SQL tab 状态 */
  dbSqlTabState?: unknown;
  /** DB 表预览状态 */
  dbTablePreview?: unknown;
  /** DB 列元数据 */
  dbTableColumnMeta?: unknown[];
  /** DB tab 模式 */
  dbTabMode?: "data" | "sql";
  /** DB 脏行 */
  dbTabDirtyRows?: Record<string, Record<string, unknown>>;
}

/**
 * 收集终端 tab 的运行时状态并返回可序列化的 payload 片段。
 * 使用动态 import 避免循环依赖。
 */
async function collectTerminalState(
  sessionId: string,
): Promise<Pick<TabStatePayload, "terminalHistory" | "shellHistory" | "blocks">> {
  const result: Pick<TabStatePayload, "terminalHistory" | "shellHistory" | "blocks"> = {};

  // 终端历史（已持久化的 blocks）
  try {
    const { useTerminalHistoryStore } = await import("../stores/terminalHistoryStore");
    const history = useTerminalHistoryStore.getState().bySession[sessionId];
    if (history && history.length > 0) {
      result.terminalHistory = history;
    }
  } catch {
    /* ignore */
  }

  // shell 命令历史
  try {
    const { useSessionShellHistoryStore } = await import(
      "../modules/terminal/commandBar/sessionShellHistoryStore"
    );
    const shellHist = useSessionShellHistoryStore.getState().bySession[sessionId];
    if (shellHist) {
      result.shellHistory = shellHist;
    }
  } catch {
    /* ignore */
  }

  // 内存 blocks（marker 置 null，liveOutput 不可序列化需移除）
  try {
    const { useBlocksStore } = await import("../stores/blocksStore");
    const blocks = useBlocksStore.getState().blocks[sessionId];
    if (blocks && blocks.length > 0) {
      result.blocks = blocks.map((b) => ({
        ...b,
        marker: null,
        liveOutput: undefined,
      }));
    }
  } catch {
    /* ignore */
  }

  return result;
}

/**
 * 收集数据库 tab 的运行时状态。
 * `tabId` 为源窗口 store 中的 key（模块 dock 中为 bareId，工作区 dock 中为完整 id）。
 */
async function collectDatabaseState(
  tabId: string,
): Promise<
  Pick<
    TabStatePayload,
    | "dbSqlTabState"
    | "dbTablePreview"
    | "dbTableColumnMeta"
    | "dbTabMode"
    | "dbTabDirtyRows"
  >
> {
  const result: Pick<
    TabStatePayload,
    | "dbSqlTabState"
    | "dbTablePreview"
    | "dbTableColumnMeta"
    | "dbTabMode"
    | "dbTabDirtyRows"
  > = {};

  try {
    const { useDbWorkspaceTabStore } = await import("../stores/dbWorkspaceTabStore");
    const state = useDbWorkspaceTabStore.getState();
    if (state.sqlTabStates[tabId]) result.dbSqlTabState = state.sqlTabStates[tabId];
    if (state.tablePreviews[tabId]) result.dbTablePreview = state.tablePreviews[tabId];
    if (state.tableColumnMeta[tabId]) result.dbTableColumnMeta = state.tableColumnMeta[tabId];
    if (state.tabModes[tabId]) result.dbTabMode = state.tabModes[tabId];
    if (state.tabDirtyRows[tabId]) result.dbTabDirtyRows = state.tabDirtyRows[tabId];
  } catch {
    /* ignore */
  }

  return result;
}

/**
 * 收集 tab 运行时状态。
 *
 * - terminal：通过 `sessionId` 关联终端历史 / shell 历史 / blocks
 * - database：通过 `panelId`（源窗口 store key）关联数据库 tab 状态
 *
 * 注意：`dbTabId` 是目标窗口 store 中的 key（可能带 `workspace-bottom-{wsId}:` 前缀），
 * 与源窗口的 `panelId` 不同。收集时使用 `panelId`，应用时使用 `dbTabId`。
 */
async function collectTabState(
  panelId: string,
  module: "terminal" | "database",
  sessionId?: string,
): Promise<Partial<TabStatePayload>> {
  if (module === "terminal" && sessionId) {
    return collectTerminalState(sessionId);
  }
  if (module === "database") {
    return collectDatabaseState(panelId);
  }
  return {};
}

/**
 * 在 tab 跨窗口转移时，收集源窗口中该 tab 关联的所有 store 状态切片，
 * 通过 Tauri `emitTo` 发送到目标窗口。
 *
 * @param targetLabel 目标窗口 label
 * @param panelId 源 dockview 中的 panelId（也是源 store 中的 key）
 * @param module 模块类型
 * @param sessionId 终端 sessionId（terminal 模块）
 * @param dbTabId 目标窗口 store 中的 key（database 模块，可能带前缀）
 */
export async function sendTabStateTransfer(
  targetLabel: string,
  panelId: string,
  module: "terminal" | "database",
  sessionId?: string,
  dbTabId?: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const currentLabel = getCurrentWebviewWindow().label;
  const payload: TabStatePayload = {
    sourceLabel: currentLabel,
    targetLabel,
    panelId,
    module,
    sessionId,
    dbTabId,
  };
  Object.assign(payload, await collectTabState(panelId, module, sessionId));
  await emitTo(targetLabel, TAB_STATE_TRANSFER_EVENT, payload).catch(() => {});
}

/**
 * 注入终端状态到目标窗口的 store。
 */
async function applyTerminalState(
  sessionId: string,
  payload: TabStatePayload,
): Promise<void> {
  if (payload.terminalHistory) {
    try {
      const { useTerminalHistoryStore } = await import("../stores/terminalHistoryStore");
      useTerminalHistoryStore.setState((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: payload.terminalHistory as never,
        },
      }));
    } catch {
      /* ignore */
    }
  }
  if (payload.shellHistory) {
    try {
      const { useSessionShellHistoryStore } = await import(
        "../modules/terminal/commandBar/sessionShellHistoryStore"
      );
      useSessionShellHistoryStore.setState((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: payload.shellHistory!,
        },
      }));
    } catch {
      /* ignore */
    }
  }
  if (payload.blocks) {
    try {
      const { useBlocksStore } = await import("../stores/blocksStore");
      useBlocksStore.setState((state) => ({
        blocks: {
          ...state.blocks,
          [sessionId]: payload.blocks as never,
        },
      }));
    } catch {
      /* ignore */
    }
  }
}

/**
 * 注入数据库 tab 状态到目标窗口的 store。
 * `tabId` 是目标窗口 store 中的 key（由 payload.dbTabId 提供）。
 */
async function applyDatabaseState(
  tabId: string,
  payload: TabStatePayload,
): Promise<void> {
  try {
    const { useDbWorkspaceTabStore } = await import("../stores/dbWorkspaceTabStore");
    const updates: Record<string, unknown> = {};
    if (payload.dbSqlTabState) {
      updates.sqlTabStates = { [tabId]: payload.dbSqlTabState };
    }
    if (payload.dbTablePreview) {
      updates.tablePreviews = { [tabId]: payload.dbTablePreview };
    }
    if (payload.dbTableColumnMeta) {
      updates.tableColumnMeta = { [tabId]: payload.dbTableColumnMeta };
    }
    if (payload.dbTabMode) {
      updates.tabModes = { [tabId]: payload.dbTabMode };
    }
    if (payload.dbTabDirtyRows) {
      updates.tabDirtyRows = { [tabId]: payload.dbTabDirtyRows };
    }
    if (Object.keys(updates).length > 0) {
      useDbWorkspaceTabStore.setState((state) => {
        const next: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(updates)) {
          const current = (state as Record<string, unknown>)[key];
          next[key] = { ...(current as Record<string, unknown>), ...(val as Record<string, unknown>) };
        }
        return next as never;
      });
    }
  } catch {
    /* ignore */
  }
}

/**
 * 在目标窗口监听 tab 状态转移事件并注入到对应 store。
 * 应在窗口挂载时调用，卸载时调用返回的清理函数。
 */
export async function initTabStateTransferListener(): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};

  const unlisten: UnlistenFn = await listen<TabStatePayload>(
    TAB_STATE_TRANSFER_EVENT,
    async (event) => {
      const payload = event.payload;
      if (!payload) return;
      if (payload.targetLabel !== getCurrentWebviewWindow().label) return;

      if (payload.module === "terminal" && payload.sessionId) {
        await applyTerminalState(payload.sessionId, payload);
      } else if (payload.module === "database" && payload.dbTabId) {
        await applyDatabaseState(payload.dbTabId, payload);
      }
    },
  );

  return unlisten;
}

/**
 * 应用单个 tab 状态 payload（handoff 水合时使用）。
 * 根据模块类型分发到 applyTerminalState / applyDatabaseState。
 */
export async function applyTabStatePayload(payload: TabStatePayload): Promise<void> {
  if (payload.module === "terminal" && payload.sessionId) {
    await applyTerminalState(payload.sessionId, payload);
  } else if (payload.module === "database" && payload.dbTabId) {
    await applyDatabaseState(payload.dbTabId, payload);
  }
}

/**
 * 窗口关闭时收集所有 tab 状态，写入 handoff JSON。
 * 遍历 workspaceBottomDockStore 中的所有 tabs，对每个 terminal/database tab 收集状态。
 * 返回 { panelId: payload } 映射，由 handoff 逻辑序列化。
 *
 * 各 tab 的状态收集互不依赖（写入不同 sessionId / dbTabId），使用 Promise.all 并行
 * 收集，避免 N 个 tab × 3~4 次动态 import 串行 await 导致的秒级延迟。
 */
export async function collectAllTabStatesForHandoff(
  workspaceId: string,
): Promise<Record<string, TabStatePayload>> {
  const currentLabel = isTauriRuntime() ? getCurrentWebviewWindow().label : "main";

  try {
    const { useWorkspaceBottomDockStore } = await import(
      "../stores/workspaceBottomDockStore"
    );
    const tabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];

    const entries = await Promise.all(
      tabs.map(async (tab): Promise<[string, TabStatePayload] | null> => {
        const panelId = tab.id;
        const payload: TabStatePayload = {
          sourceLabel: currentLabel,
          targetLabel: "",
          panelId,
          module: "terminal", // placeholder, overwritten below
        };

        // Payload tabs（带 snapshot）
        if (tab.kind === "payload" && tab.payload) {
          const snapshot = tab.payload;
          if (snapshot.module === "terminal") {
            payload.module = "terminal";
            const sessionId = snapshot.id;
            payload.sessionId = sessionId;
            Object.assign(payload, await collectTerminalState(sessionId));
            return [panelId, payload];
          }
          if (snapshot.module === "database") {
            payload.module = "database";
            payload.dbTabId = panelId;
            Object.assign(payload, await collectDatabaseState(panelId));
            return [panelId, payload];
          }
          return null;
        }

        // Mirrored tabs（从模块 dock 镜像）
        if (tab.kind === "mirrored" && tab.originScope) {
          if (tab.originScope === "terminal" && tab.originPanelId) {
            payload.module = "terminal";
            try {
              const { useTerminalStore } = await import("../stores/terminalStore");
              const sessionId =
                useTerminalStore.getState().tabs.find(
                  (t) => t.id === tab.originPanelId,
                )?.sessionId ?? tab.originPanelId;
              payload.sessionId = sessionId;
              Object.assign(payload, await collectTerminalState(sessionId));
              return [panelId, payload];
            } catch {
              return null;
            }
          }
          if (tab.originScope === "database" && tab.originPanelId) {
            payload.module = "database";
            payload.dbTabId = panelId;
            Object.assign(payload, await collectDatabaseState(tab.originPanelId));
            return [panelId, payload];
          }
        }
        return null;
      }),
    );

    const result: Record<string, TabStatePayload> = {};
    for (const entry of entries) {
      if (entry) result[entry[0]] = entry[1];
    }
    return result;
  } catch {
    return {};
  }
}

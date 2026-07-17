import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "./isTauriRuntime";
import type { TerminalBlock } from "../stores/blocksStore";

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
  /**
   * @deprecated SQLite 共享后不再发送；仅兼容旧 handoff JSON。
   * 目标窗优先 `loadSession(sessionId)`。
   */
  terminalHistory?: unknown[];
  /** shell 命令历史（仍在分窗 localStorage，需显式传递） */
  shellHistory?: { commands: string[]; syncedAt: number };
  /**
   * 仅传 `status === "running"` 的 live 块；已完成块由目标窗从 SQLite 加载。
   */
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

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** 同一 handoff/批量收集周期内避免对同一 session 重复 force flush */
const flushedSessionsThisTick = new Set<string>();
let flushTickScheduled = false;

function beginFlushDedupeWindow(): void {
  if (flushTickScheduled) return;
  flushTickScheduled = true;
  queueMicrotask(() => {
    flushedSessionsThisTick.clear();
    flushTickScheduled = false;
  });
}

async function ensureSessionFlushed(sessionId: string): Promise<void> {
  beginFlushDedupeWindow();
  if (flushedSessionsThisTick.has(sessionId)) return;
  flushedSessionsThisTick.add(sessionId);
  const { flushSessionNow } = await import("../modules/terminal/terminalHistorySync");
  await flushSessionNow(sessionId);
}

function serializeRunningBlock(block: TerminalBlock): Record<string, unknown> {
  return {
    ...block,
    marker: null,
    liveOutput: undefined,
  };
}

/**
 * 收集终端 tab 跨窗状态：先 flush 到共享 SQLite，再只带 shell 历史 + running 块。
 */
async function collectTerminalState(
  sessionId: string,
  options?: { skipFlush?: boolean },
): Promise<Pick<TabStatePayload, "shellHistory" | "blocks">> {
  const result: Pick<TabStatePayload, "shellHistory" | "blocks"> = {};

  if (!options?.skipFlush) {
    try {
      await ensureSessionFlushed(sessionId);
    } catch {
      /* flush 失败仍继续传 running，避免拖拽完全失败 */
    }
  }

  await yieldToUi();

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

  try {
    const { useBlocksStore } = await import("../stores/blocksStore");
    const blocks = useBlocksStore.getState().blocks[sessionId] ?? [];
    const running = blocks.filter((b) => b.status === "running");
    if (running.length > 0) {
      result.blocks = running.map(serializeRunningBlock);
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
 * - terminal：flush → SQLite；payload 仅 shellHistory + running blocks
 * - database：通过 `panelId`（源窗口 store key）关联数据库 tab 状态
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

function mergeRunningOverlay(
  base: TerminalBlock[],
  runningRaw: unknown[],
): TerminalBlock[] {
  const byId = new Map(base.map((b) => [b.id, b]));
  for (const raw of runningRaw) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as TerminalBlock;
    if (!block.id) continue;
    byId.set(block.id, {
      ...block,
      marker: null,
      liveOutput: undefined,
    });
  }
  return [...byId.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/**
 * 目标窗：从共享 SQLite 冷灌入，再用 payload 中的 running 块覆盖。
 * 旧 handoff 若带 terminalHistory 且库为空，则作兼容回退。
 */
async function applyTerminalState(
  sessionId: string,
  payload: TabStatePayload,
): Promise<void> {
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

  const { useBlocksStore, syncBlockCounterFromIds } = await import("../stores/blocksStore");
  const store = useBlocksStore.getState();
  if (store.getBlocks(sessionId).length > 0) {
    // 目标窗已有 live 时间线：只合并 running，避免冲掉进行中会话
    if (payload.blocks?.length) {
      const current = store.getBlocks(sessionId);
      const merged = mergeRunningOverlay(current, payload.blocks);
      const { noteRestoredSessionBlocks } = await import(
        "../modules/terminal/terminalHistorySync"
      );
      noteRestoredSessionBlocks(sessionId, merged);
      store.replaceSessionBlocks(sessionId, merged);
      syncBlockCounterFromIds(merged);
    }
    return;
  }

  await yieldToUi();

  let restored: TerminalBlock[] = [];
  try {
    const { terminalHistoryRepo } = await import("../modules/terminal/terminalHistoryRepo");
    const { normalizeRestoredTerminalBlock } = await import(
      "../modules/terminal/terminalBlockRestore"
    );
    const { useTerminalHistoryStore } = await import("../stores/terminalHistoryStore");
    const persisted = await terminalHistoryRepo.loadSession(sessionId);
    if (persisted.length > 0) {
      useTerminalHistoryStore.setState((state) => ({
        bySession: { ...state.bySession, [sessionId]: persisted },
      }));
      restored = persisted.map(normalizeRestoredTerminalBlock);
    } else if (payload.terminalHistory?.length) {
      // 兼容旧 handoff：库空时回退到 payload，并后台写入 SQLite
      const legacy = payload.terminalHistory as import("../stores/terminalHistoryStore").PersistedTerminalBlock[];
      restored = legacy.map(normalizeRestoredTerminalBlock);
      useTerminalHistoryStore.setState((state) => ({
        bySession: { ...state.bySession, [sessionId]: legacy },
      }));
      void import("../modules/terminal/terminalHistoryRepo").then(({ persistedBlockToRecord, terminalHistoryRepo: repo }) => {
        const records = legacy.map((b) => persistedBlockToRecord(sessionId, b));
        void repo.upsertRecords(sessionId, records).catch(() => undefined);
      });
    }
  } catch {
    /* ignore */
  }

  if (payload.blocks?.length) {
    restored = mergeRunningOverlay(restored, payload.blocks);
  }

  if (restored.length === 0) return;

  await yieldToUi();

  const { noteRestoredSessionBlocks } = await import("../modules/terminal/terminalHistorySync");
  noteRestoredSessionBlocks(sessionId, restored);
  store.replaceSessionBlocks(sessionId, restored);
  syncBlockCounterFromIds(restored);
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
          const current = (state as unknown as Record<string, unknown>)[key];
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
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      if (payload.targetLabel !== getCurrentWebviewWindow().label) return;

      // 不 await：避免事件回调串行阻塞；内部自行 yield + 异步灌入
      if (payload.module === "terminal" && payload.sessionId) {
        void applyTerminalState(payload.sessionId, payload);
      } else if (payload.module === "database" && payload.dbTabId) {
        void applyDatabaseState(payload.dbTabId, payload);
      }
    },
  );

  return unlisten;
}

/**
 * 应用单个 tab 状态 payload（handoff 水合时使用）。
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
 * 终端侧先 flush 再只序列化轻量字段，避免 handoff 文件膨胀。
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

    // 先并行解析 sessionId，再串行 flush（让出 UI），最后并行收集轻量 payload
    type TerminalTabJob = { panelId: string; sessionId: string };
    type DatabaseTabJob = { panelId: string; collectKey: string };
    const terminalJobs: TerminalTabJob[] = [];
    const databaseJobs: DatabaseTabJob[] = [];

    for (const tab of tabs) {
      const panelId = tab.id;
      if (tab.kind === "payload" && tab.payload) {
        if (tab.payload.module === "terminal") {
          terminalJobs.push({ panelId, sessionId: tab.payload.id });
        } else if (tab.payload.module === "database") {
          databaseJobs.push({ panelId, collectKey: panelId });
        }
        continue;
      }
      if (tab.kind === "mirrored" && tab.originScope) {
        if (tab.originScope === "terminal" && tab.originPanelId) {
          try {
            const { useTerminalStore } = await import("../stores/terminalStore");
            const sessionId =
              useTerminalStore.getState().tabs.find((t) => t.id === tab.originPanelId)
                ?.sessionId ?? tab.originPanelId;
            terminalJobs.push({ panelId, sessionId });
          } catch {
            /* skip */
          }
        } else if (tab.originScope === "database" && tab.originPanelId) {
          databaseJobs.push({ panelId, collectKey: tab.originPanelId });
        }
      }
    }

    // 串行 flush + 每步让出一帧，避免关窗时主线程长时间占用
    const uniqueSessions = [...new Set(terminalJobs.map((j) => j.sessionId))];
    for (const sessionId of uniqueSessions) {
      try {
        await ensureSessionFlushed(sessionId);
      } catch {
        /* ignore */
      }
      await yieldToUi();
    }

    const result: Record<string, TabStatePayload> = {};

    await Promise.all(
      terminalJobs.map(async ({ panelId, sessionId }) => {
        const payload: TabStatePayload = {
          sourceLabel: currentLabel,
          targetLabel: "",
          panelId,
          module: "terminal",
          sessionId,
        };
        Object.assign(payload, await collectTerminalState(sessionId, { skipFlush: true }));
        result[panelId] = payload;
      }),
    );

    await Promise.all(
      databaseJobs.map(async ({ panelId, collectKey }) => {
        const payload: TabStatePayload = {
          sourceLabel: currentLabel,
          targetLabel: "",
          panelId,
          module: "database",
          dbTabId: panelId,
        };
        Object.assign(payload, await collectDatabaseState(collectKey));
        result[panelId] = payload;
      }),
    );

    return result;
  } catch {
    return {};
  }
}

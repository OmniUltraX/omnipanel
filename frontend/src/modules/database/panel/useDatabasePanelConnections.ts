import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { appAlert } from "../../../lib/appAlert";
import { appConfirm } from "../../../lib/appConfirm";
import {
  listConnections,
  deleteConnection,
  loadSchemaCache,
  loadSchemaFilters,
  loadSchemaTreeExpanded,
  saveConnection,
  isConnectionEnabled,
  isMysqlConnectionInfoCapable,
  type DbConnectionConfig,
} from "../api";
import {
  DB_CONNECTIONS_CHANGED_EVENT,
  useDbConnectionListStore,
} from "../../../stores/dbConnectionListStore";
import { useDbConnectionRuntimeStore } from "../../../stores/dbConnectionRuntimeStore";
import { useDbSchemaFilterStore } from "../../../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { CLIENT_SYNC_MODULES_APPLIED_EVENT } from "../../clientSync";
import { snapshotToFilterStates } from "../schema/schemaFilters";
import type { SchemaCacheSnapshot } from "../schema/schemaCache";
import { connectionNodeId } from "../schema/schemaTreeExpanded";
import { loadNavicatImportPreview } from "../navicatImport/loadNavicatNcxFile";
import type { NavicatImportPreviewItem } from "../navicatImport/types";
import {
  probeSlowLogAvailability,
  resolveSlowLogAvailabilitySync,
  type SlowLogAvailability,
} from "../mysqlSlowQueryLog";
import {
  probeBinlogAvailability,
  resolveBinlogAvailabilitySync,
  type BinlogAvailability,
} from "../mysqlBinlog";
import { resolveConnIdForWorkspaceTab } from "../workspace/dbWorkspaceState";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";
import type { DbWorkspaceTab } from "../workspace/workspaceTabs";
import type { Connection } from "../../../ipc/bindings";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type UseDatabasePanelConnectionsDeps = {
  connections: DbConnectionConfig[];
  setConnections: Dispatch<SetStateAction<DbConnectionConfig[]>>;
  setConnectionsLoading: Dispatch<SetStateAction<boolean>>;
  setActiveConnId: Dispatch<SetStateAction<string | null>>;
  setImportPreview: Dispatch<
    SetStateAction<{ fileName: string; items: NavicatImportPreviewItem[] } | null>
  >;
  t: Translate;
  schemaRefreshToken: number;
  setSchemaRefreshToken: Dispatch<SetStateAction<number>>;
  slowLogAvailabilityByConnId: Record<string, SlowLogAvailability>;
  setSlowLogAvailabilityByConnId: Dispatch<SetStateAction<Record<string, SlowLogAvailability>>>;
  binlogAvailabilityByConnId: Record<string, BinlogAvailability>;
  setBinlogAvailabilityByConnId: Dispatch<SetStateAction<Record<string, BinlogAvailability>>>;
  sshConnections: Connection[];
  updateSchemaExpanded: ReturnType<typeof useDbSchemaTreeExpandedStore.getState>["updateExpanded"];
  workspaceTabsRef: MutableRefObject<DbWorkspaceTab[]>;
  closeWorkspaceTabs: (tabIds: string[]) => void;
  setDatabasesByConnId: Dispatch<SetStateAction<Record<string, string[]>>>;
  setCreateDbDialog: Dispatch<SetStateAction<{ connId: string } | null>>;
  editingConnection: DbConnectionConfig | null;
  setEditingConnection: Dispatch<SetStateAction<DbConnectionConfig | null>>;
  setDialogOpen: Dispatch<SetStateAction<boolean>>;
};

export function useDatabasePanelConnections(deps: UseDatabasePanelConnectionsDeps) {
  const {
    connections,
    setConnections,
    setConnectionsLoading,
    setActiveConnId,
    setImportPreview,
    t,
    schemaRefreshToken,
    setSchemaRefreshToken,
    slowLogAvailabilityByConnId,
    setSlowLogAvailabilityByConnId,
    binlogAvailabilityByConnId,
    setBinlogAvailabilityByConnId,
    sshConnections,
    updateSchemaExpanded,
    workspaceTabsRef,
    closeWorkspaceTabs,
    setDatabasesByConnId,
    setCreateDbDialog,
    editingConnection,
    setEditingConnection,
    setDialogOpen,
  } = deps;

  const refreshConnections = useCallback(async () => {
    // 已有列表时不进入全屏 loading，避免刷新时把侧栏树卸掉
    if (connections.length === 0) {
      setConnectionsLoading(true);
    }
    try {
      const list = await listConnections();
      setConnections(list);
      // 与自定义面板 / AI @ 菜单共享缓存保持一致（侧栏本地 state 之外）
      useDbConnectionListStore.getState().hydrate(list);
      setActiveConnId((prev) => {
        const pickEnabled = (items: DbConnectionConfig[]) =>
          items.find((item) => isConnectionEnabled(item));
        if (prev) {
          const current = list.find((item) => item.id === prev);
          if (current && isConnectionEnabled(current)) {
            return prev;
          }
        }
        return pickEnabled(list)?.id ?? null;
      });
    } catch {
      // 连接列表加载失败时保留当前状态
    } finally {
      setConnectionsLoading(false);
    }
  }, [connections.length]);

  const handleImportConnections = useCallback(async () => {
    try {
      const preview = await loadNavicatImportPreview(connections);
      if (!preview) {
        return;
      }
      setImportPreview(preview);
    } catch (error) {
      const message =
        String(error).includes("EMPTY")
          ? t("database.connectionImport.emptyFile")
          : t("database.connectionImport.parseFailed", { error: String(error) });
      await appAlert(message, t("database.connectionImport.previewTitle"));
    }
  }, [connections, t]);

  useEffect(() => {
    void refreshConnections();
  }, [schemaRefreshToken, refreshConnections]);
  useEffect(() => {
    const onChanged = () => {
      void refreshConnections();
    };
    window.addEventListener(CLIENT_SYNC_MODULES_APPLIED_EVENT, onChanged);
    window.addEventListener(DB_CONNECTIONS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(CLIENT_SYNC_MODULES_APPLIED_EVENT, onChanged);
      window.removeEventListener(DB_CONNECTIONS_CHANGED_EVENT, onChanged);
    };
  }, [refreshConnections]);

  const resolveSlowLogDisabledReason = useCallback(
    (availability: SlowLogAvailability): string => {
      switch (availability.reason) {
        case "not_mysql":
          return t("database.contextMenu.slowQueryLogDisabled.notMysql");
        case "no_ssh":
          return t("database.contextMenu.slowQueryLogDisabled.noSsh");
        case "ssh_not_connected":
          return t("database.contextMenu.slowQueryLogDisabled.sshNotConnected");
        case "connection_disabled":
          return t("database.contextMenu.slowQueryLogDisabled.connectionDisabled");
        case "checking":
          return t("database.contextMenu.slowQueryLogDisabled.checking");
        case "slow_log_off":
          return t("database.contextMenu.slowQueryLogDisabled.slowLogOff");
        case "slow_log_file_missing":
          return t("database.contextMenu.slowQueryLogDisabled.slowLogFileMissing");
        default:
          return t("database.contextMenu.slowQueryLogDisabled.probeFailed");
      }
    },
    [t],
  );

  const resolveBinlogDisabledReason = useCallback(
    (availability: BinlogAvailability): string => {
      switch (availability.reason) {
        case "not_mysql":
          return t("database.contextMenu.binlogDisabled.notMysql");
        case "no_ssh":
          return t("database.contextMenu.binlogDisabled.noSsh");
        case "ssh_not_connected":
          return t("database.contextMenu.binlogDisabled.sshNotConnected");
        case "connection_disabled":
          return t("database.contextMenu.binlogDisabled.connectionDisabled");
        case "checking":
          return t("database.contextMenu.binlogDisabled.checking");
        case "binlog_off":
          return t("database.contextMenu.binlogDisabled.binlogOff");
        case "binlog_encrypted":
          return t("database.contextMenu.binlogDisabled.binlogEncrypted");
        default:
          return t("database.contextMenu.binlogDisabled.probeFailed");
      }
    },
    [t],
  );

  /** 按需探测慢日志（进入模块不再批量连库/SSH） */
  const ensureSlowLogAvailability = useCallback(
    async (connection: DbConnectionConfig): Promise<SlowLogAvailability> => {
      const cached = slowLogAvailabilityByConnId[connection.id];
      if (cached && cached.reason !== "checking") {
        return cached;
      }
      const result = await probeSlowLogAvailability(connection, sshConnections);
      setSlowLogAvailabilityByConnId((prev) => ({ ...prev, [connection.id]: result }));
      return result;
    },
    [slowLogAvailabilityByConnId, sshConnections],
  );

  const ensureBinlogAvailability = useCallback(
    async (connection: DbConnectionConfig): Promise<BinlogAvailability> => {
      const cached = binlogAvailabilityByConnId[connection.id];
      if (cached && cached.reason !== "checking") {
        return cached;
      }
      const result = await probeBinlogAvailability(connection, sshConnections);
      setBinlogAvailabilityByConnId((prev) => ({ ...prev, [connection.id]: result }));
      return result;
    },
    [binlogAvailabilityByConnId, sshConnections],
  );

  useEffect(() => {
    const mysqlConnections = connections.filter(isMysqlConnectionInfoCapable);
    if (mysqlConnections.length === 0) {
      setSlowLogAvailabilityByConnId({});
      return;
    }

    // 仅同步推断（是否匹配 SSH），不主动连库/连 SSH；真正探测在打开菜单或点击时按需进行
    const syncMap: Record<string, SlowLogAvailability> = {};
    for (const conn of mysqlConnections) {
      if (!isConnectionEnabled(conn)) {
        syncMap[conn.id] = { enabled: false, reason: "connection_disabled" };
        continue;
      }
      syncMap[conn.id] = resolveSlowLogAvailabilitySync(conn, sshConnections);
    }
    setSlowLogAvailabilityByConnId((prev) => {
      const next = { ...syncMap };
      // 保留已异步探测成功的结果，避免被 sync 覆盖回 checking
      for (const [id, prevAvail] of Object.entries(prev)) {
        if (prevAvail.enabled || (prevAvail.reason && prevAvail.reason !== "checking")) {
          if (next[id]?.reason === "checking" || next[id] == null) {
            next[id] = prevAvail;
          }
        }
      }
      return next;
    });
  }, [connections, sshConnections]);

  useEffect(() => {
    const mysqlConnections = connections.filter(isMysqlConnectionInfoCapable);
    if (mysqlConnections.length === 0) {
      setBinlogAvailabilityByConnId({});
      return;
    }

    const syncMap: Record<string, BinlogAvailability> = {};
    for (const conn of mysqlConnections) {
      if (!isConnectionEnabled(conn)) {
        syncMap[conn.id] = { enabled: false, reason: "connection_disabled" };
        continue;
      }
      syncMap[conn.id] = resolveBinlogAvailabilitySync(conn, sshConnections);
    }
    setBinlogAvailabilityByConnId((prev) => {
      const next = { ...syncMap };
      for (const [id, prevAvail] of Object.entries(prev)) {
        if (prevAvail.enabled || (prevAvail.reason && prevAvail.reason !== "checking")) {
          if (next[id]?.reason === "checking" || next[id] == null) {
            next[id] = prevAvail;
          }
        }
      }
      return next;
    });
  }, [connections, sshConnections]);
  const toggleConnectionEnabled = useCallback(
    async (connId: string, enabled: boolean) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      try {
        await saveConnection({ ...connection, enabled });
        useDbConnectionRuntimeStore.getState().syncEnabled(connId, enabled);
        if (!enabled) {
          updateSchemaExpanded((prev) => {
            const next = new Set(prev);
            next.delete(connectionNodeId(connId));
            return next;
          });
          setActiveConnId((prev) => (prev === connId ? null : prev));
        }
        setSchemaRefreshToken((token) => token + 1);
      } catch (err) {
        console.error("[DatabasePanel] toggleConnectionEnabled failed", err);
      }
    },
    [connections, updateSchemaExpanded],
  );

  const reloadSchemaSidecarAfterConnectionDelete = useCallback(async () => {
    const [filterSnap, expandedSnap, cacheSnap] = await Promise.all([
      loadSchemaFilters(),
      loadSchemaTreeExpanded(),
      loadSchemaCache(),
    ]);
    const loaded = snapshotToFilterStates(filterSnap);
    useDbSchemaFilterStore.setState({
      databaseFilters: loaded.databaseFilters,
      tableFilters: loaded.tableFilters,
      hydrated: true,
    });
    useDbSchemaTreeExpandedStore.setState({
      expandedNodeIds: new Set(expandedSnap.expandedNodeIds ?? []),
      hydrated: true,
    });
    useDbSchemaCacheStore.setState({
      // IPC Deserialize 与前端 SchemaCacheSnapshot 结构对齐，hydrate 同路用断言
      snapshot: cacheSnap as SchemaCacheSnapshot,
      hydrated: true,
    });
  }, []);

  const handleDeleteConnection = useCallback(
    async (connection: DbConnectionConfig | DbConnectionConfig[]): Promise<boolean> => {
      const targets = Array.isArray(connection) ? connection : [connection];
      if (targets.length === 0) return false;

      const confirmed = await appConfirm(
        targets.length === 1
          ? t("database.contextMenu.deleteConnectionConfirm", { name: targets[0]!.name })
          : t("sidebarTree.confirmDeleteSelected", { count: String(targets.length) }),
        t("database.contextMenu.deleteConnectionTitle"),
        {
          confirmLabel: t("database.contextMenu.deleteConnection"),
          cancelLabel: t("common.cancel"),
          kind: "warning",
        },
      );
      if (!confirmed) {
        return false;
      }

      for (const target of targets) {
        const connId = target.id;
        const tabStore = useDbWorkspaceTabStore.getState();
        const tabIdsToClose = workspaceTabsRef.current
          .filter((tab) => resolveConnIdForWorkspaceTab(tab, tabStore) === connId)
          .map((tab) => tab.id);
        if (tabIdsToClose.length > 0) {
          closeWorkspaceTabs(tabIdsToClose);
        }

        try {
          await deleteConnection(connId);
        } catch (err) {
          console.error("[DatabasePanel] deleteConnection failed", err);
          continue;
        }

        setDatabasesByConnId((prev) => {
          if (!(connId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[connId];
          return next;
        });
        setActiveConnId((prev) => (prev === connId ? null : prev));
        setCreateDbDialog((prev) => (prev?.connId === connId ? null : prev));
        if (editingConnection?.id === connId) {
          setEditingConnection(null);
          setDialogOpen(false);
        }
      }

      await reloadSchemaSidecarAfterConnectionDelete();
      setSchemaRefreshToken((token) => token + 1);
      return true;
    },
    [
      t,
      closeWorkspaceTabs,
      editingConnection?.id,
      reloadSchemaSidecarAfterConnectionDelete,
    ],
  );

  return {
    refreshConnections,
    handleImportConnections,
    resolveSlowLogDisabledReason,
    resolveBinlogDisabledReason,
    ensureSlowLogAvailability,
    ensureBinlogAvailability,
    toggleConnectionEnabled,
    reloadSchemaSidecarAfterConnectionDelete,
    handleDeleteConnection,
  };
}

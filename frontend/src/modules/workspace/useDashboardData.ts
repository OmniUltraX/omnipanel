import { useEffect, useMemo, useState } from "react";
import { commands, type DockerContainerSummary } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { useActionStore } from "../../stores/actionStore";
import { useBlocksStore, isAiThreadToolCall, type TerminalBlock } from "../../stores/blocksStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSshStatsStore } from "../../stores/sshStatsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspaceTabStore } from "../../stores/workspaceTabStore";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../terminal/paneResource";
import {
  isInlineTerminalToolName,
} from "../terminal/inlineTerminalTool";
import { getResolvedAiThread } from "../terminal/aiThreadBridge";
import { shouldRequireTerminalApproval } from "../terminal/terminalApprovalPolicy";
import { resolveTerminalApprovalMode } from "../terminal/terminalApprovalSettings";
import { MODULE_PATHS } from "../../lib/paths";
import {
  buildActiveTasks,
  buildContainerItems,
  buildDraftRows,
  buildQuickConnectItems,
  buildResourceBars,
  buildServerItems,
  buildWorkspaceCards,
  connectionNameMap,
  envLabel,
  formatRelativeTime,
  typeLabel,
  type DashboardContainerItem,
  type DashboardDraftRow,
  type DashboardQuickConnect,
  type DashboardResourceBar,
  type DashboardServerItem,
  type DashboardTaskRow,
  type DashboardWorkspaceCard,
} from "./dashboardModel";

function resolveToolCallCommand(args: string, command?: string): string {
  const direct = command?.trim();
  if (direct) return direct;
  try {
    const parsed = JSON.parse(args) as { command?: string };
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // ignore
  }
  return "";
}

function collectAiDrafts(
  blocksBySession: Record<string, TerminalBlock[]>,
): DashboardDraftRow[] {
  const drafts: DashboardDraftRow[] = [];

  for (const [sessionId, blocks] of Object.entries(blocksBySession)) {
    const mode = resolveTerminalApprovalMode(sessionId);
    for (const block of blocks) {
      if (block.kind !== "ai") continue;
      const thread = getResolvedAiThread(block);
      for (const item of thread) {
        if (
          !isAiThreadToolCall(item) ||
          !isInlineTerminalToolName(item.toolName) ||
          item.status !== "pending"
        ) {
          continue;
        }
        const command = resolveToolCallCommand(item.args, item.command);
        if (!shouldRequireTerminalApproval(command, mode)) continue;
        drafts.push({
          id: `ai-tool-${item.id}`,
          title: command || item.toolName,
          time: `AI 命令 · ${block.title?.trim() || sessionId}`,
          dot: "var(--warn)",
          path: MODULE_PATHS.terminal,
        });
      }
    }
  }

  return drafts.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")).slice(0, 3);
}

export type DashboardData = {
  recentWorkspaces: DashboardWorkspaceCard[];
  quickConnect: DashboardQuickConnect[];
  activeTasks: DashboardTaskRow[];
  drafts: DashboardDraftRow[];
  resourceBars: DashboardResourceBar[];
  containers: DashboardContainerItem[];
  servers: DashboardServerItem[];
  containersLoading: boolean;
};

export function useDashboardData(): DashboardData {
  const { t } = useI18n();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const tabsByWorkspace = useWorkspaceTabStore((s) => s.tabsByWorkspace);
  const connections = useConnectionStore((s) => s.connections);
  const actions = useActionStore((s) => s.actions);
  const blocksBySession = useBlocksStore((s) => s.blocks);
  const statsMap = useSshStatsStore((s) => s.statsMap);

  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);

  const relativeLabels = useMemo(
    () => ({
      justNow: t("dashboard.time.justNow"),
      minutes: t("dashboard.time.minutes"),
      hours: t("dashboard.time.hours"),
      days: t("dashboard.time.days"),
    }),
    [t],
  );

  const relative = useMemo(
    () => (timestamp: number) => formatRelativeTime(timestamp, relativeLabels),
    [relativeLabels],
  );

  useEffect(() => {
    void useConnectionStore.getState().refresh();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      const localRes = await commands.localFetchStats();
      if (!cancelled && localRes.status === "ok") {
        useSshStatsStore.getState().setStats([localRes.data]);
      }

      const sshConnections = useConnectionStore
        .getState()
        .connections.filter((c) => c.kind === "ssh")
        .slice(0, 3);

      await Promise.all(
        sshConnections.map(async (connection) => {
          if (useSshStatsStore.getState().statsMap[connection.id]) return;
          const res = await commands.sshPoolFetchStats(connection.id);
          if (!cancelled && res.status === "ok") {
            useSshStatsStore.getState().setStats([res.data]);
          }
        }),
      );
    }

    void loadStats();
    return () => {
      cancelled = true;
    };
  }, [connections.length]);

  useEffect(() => {
    let cancelled = false;

    async function loadContainers() {
      setContainersLoading(true);
      try {
        const connRes = await commands.dockerListConnections();
        if (cancelled) return;
        if (connRes.status !== "ok") {
          setContainers([]);
          return;
        }

        const connectionIds = connRes.data.slice(0, 2).map((item) => item.connectionId);
        if (connectionIds.length === 0) {
          setContainers([]);
          return;
        }

        const batches = await Promise.all(
          connectionIds.map((connectionId) => commands.dockerListContainers(connectionId, null)),
        );
        if (cancelled) return;

        const merged = new Map<string, DockerContainerSummary>();
        for (const batch of batches) {
          if (batch.status !== "ok") continue;
          for (const container of batch.data) {
            merged.set(container.id, container);
          }
        }
        setContainers(Array.from(merged.values()));
      } catch {
        if (!cancelled) setContainers([]);
      } finally {
        if (!cancelled) setContainersLoading(false);
      }
    }

    void loadContainers();
    return () => {
      cancelled = true;
    };
  }, []);

  const names = useMemo(() => connectionNameMap(connections), [connections]);

  const statsList = useMemo(() => {
    const orderedIds = [
      LOCAL_TERMINAL_RESOURCE_ID,
      ...connections.filter((c) => c.kind === "ssh").map((c) => c.id),
    ];
    const seen = new Set<string>();
    const list = [];
    for (const id of orderedIds) {
      if (seen.has(id)) continue;
      const stats = statsMap[id];
      if (!stats) continue;
      seen.add(id);
      list.push(stats);
      if (list.length >= 3) break;
    }
    return list;
  }, [connections, statsMap]);

  const recentWorkspaces = useMemo(
    () =>
      buildWorkspaceCards(workspaces, currentWorkspaceId, tabsByWorkspace, {
        panels: (count) => t("dashboard.meta.panels", { count }),
        noPanels: t("dashboard.meta.noPanels"),
        active: t("dashboard.meta.active"),
      }),
    [workspaces, currentWorkspaceId, tabsByWorkspace, t],
  );

  const quickConnect = useMemo(
    () =>
      buildQuickConnectItems(connections, {
        localTerminal: t("dashboard.meta.localTerminal"),
        pendingSetup: t("dashboard.empty.pendingSetup"),
        typeLabel,
        envLabel,
      }),
    [connections, t],
  );

  const activeTasks = useMemo(
    () =>
      buildActiveTasks(actions, {
        relative,
        resource: (name, environment) =>
          [name, environment ? envLabel(environment) : ""].filter(Boolean).join(" · ") ||
          t("dashboard.meta.noResource"),
        failed: t("dashboard.meta.failed"),
      }),
    [actions, relative, t],
  );

  const aiDrafts = useMemo(() => collectAiDrafts(blocksBySession), [blocksBySession]);

  const drafts = useMemo(
    () =>
      buildDraftRows(actions, aiDrafts, {
        relative,
        resource: (name) => name ?? t("dashboard.meta.noResource"),
      }),
    [actions, aiDrafts, relative, t],
  );

  const resourceBars = useMemo(
    () =>
      buildResourceBars(statsList, names, {
        cpu: t("dashboard.meta.cpu"),
        memory: t("dashboard.meta.memory"),
        disk: t("dashboard.meta.disk"),
      }),
    [statsList, names, t],
  );

  const containerItems = useMemo(() => buildContainerItems(containers), [containers]);

  const servers = useMemo(
    () =>
      buildServerItems(connections, statsMap, {
        notCollected: t("dashboard.meta.notCollected"),
        cpu: (pct) => t("dashboard.meta.cpuPct", { pct }),
        disk: (pct) => t("dashboard.meta.diskPct", { pct }),
      }),
    [connections, statsMap, t],
  );

  return {
    recentWorkspaces,
    quickConnect,
    activeTasks,
    drafts,
    resourceBars,
    containers: containerItems,
    servers,
    containersLoading,
  };
}

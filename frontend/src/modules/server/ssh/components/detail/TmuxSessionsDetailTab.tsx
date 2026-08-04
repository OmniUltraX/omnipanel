import { useCallback, useEffect, useMemo, useState } from "react";

import { commands, type TmuxSessionInfo, type TmuxTabStat } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import { useI18n } from "@/i18n";
import { appConfirm } from "@/lib/appConfirm";
import { attachTmuxSession, focusTerminalTab, openSshTerminalSession } from "@/lib/terminalSession";
import type { WorkspaceResource } from "@/lib/resourceRegistry";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { showToast } from "@/stores/toastStore";
import { isProdHost } from "@/modules/server/ssh/utils/sshProdGuard";

type Props = {
  activeResource: WorkspaceResource | null;
};

function formatCreated(seconds: number | null): string {
  if (seconds == null || !seconds) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * 远端 tmux 会话治理视图。
 *
 * 走 exec 通道查询，因此不要求该主机当前打开着终端——遗留会话正是在没开终端时
 * 才需要被看见与清理。列表包含非本应用创建的会话，避免用户误以为「不是我建的就看不到」。
 *
 * 双向关联：每个会话如实显示当前被几个 Tab 关联（count 来自后端 sessions 表，
 * 跨所有窗口共享，不依赖 per-window 的 terminalStore）。当前窗口内的 Tab id
 * 单独从前端 store 取，用于「切换到 Tab」按钮聚焦。
 */
export function TmuxSessionsDetailTab({ activeResource }: Props) {
  const { t } = useI18n();
  const connectionId = activeResource?.id ?? null;
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [tabStats, setTabStats] = useState<TmuxTabStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const connection = useConnectionStore((s) =>
    connectionId ? s.connections.find((c) => c.id === connectionId) : undefined,
  );
  const isProd = isProdHost(activeResource, connection);

  // 当前窗口的 tabs，仅用于「切换到 Tab」时拿 firstTabId 做聚焦。
  // 关联计数以后端 tabStats 为准（跨窗口），不从这里算。
  const tabs = useTerminalStore((s) => s.tabs);

  // 会话名 → 当前窗口内第一个关联 Tab 的 id（用于聚焦）。跨窗口的关联计数走后端。
  const firstTabIdBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const tab of tabs) {
      const name = tab.session?.tmuxSession;
      if (!name) continue;
      if (tab.session?.resourceId !== connectionId) continue;
      if (tab.workspaceOnly) continue;
      if (!map.has(name)) map.set(name, tab.id);
    }
    return map;
  }, [tabs, connectionId]);

  // 后端 tabCount 查询：会话名 → 关联 Tab 数（跨所有窗口）。
  const tabCountBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const stat of tabStats) {
      map.set(stat.sessionName, stat.tabCount);
    }
    return map;
  }, [tabStats]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    try {
      const [sessionList, stats] = await Promise.all([
        unwrapCommand(commands.sshTmuxListSessions(connectionId)),
        unwrapCommand(commands.sshTmuxTabStats(connectionId)).catch(() => [] as TmuxTabStat[]),
      ]);
      setSessions(sessionList);
      setTabStats(stats);
    } catch (err) {
      setError(formatIpcError(err));
      setSessions([]);
      setTabStats([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 终端 tab 增删/状态变化时刷新关联计数（聚焦用的 firstTabId 走 store 订阅自动更新）。
  useEffect(() => {
    if (!connectionId) return;
    const refresh = () => {
      void unwrapCommand(commands.sshTmuxTabStats(connectionId))
        .then(setTabStats)
        .catch(() => {});
    };
    window.addEventListener("omnipanel-terminal-focus-tab", refresh);
    return () => window.removeEventListener("omnipanel-terminal-focus-tab", refresh);
  }, [connectionId]);

  const handleKill = async (session: TmuxSessionInfo) => {
    if (!connectionId) return;
    const message = [
      t("ssh.tmuxSessions.killConfirm", { name: session.name, windows: session.windows }),
      isProd ? t("ssh.tmuxSessions.killProdWarning") : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const ok = await appConfirm(message, t("ssh.tmuxSessions.kill"), {
      kind: "error",
      confirmLabel: t("ssh.tmuxSessions.kill"),
    });
    if (!ok) return;
    setKilling(session.name);
    try {
      await unwrapCommand(commands.sshTmuxKillSession(connectionId, session.name));
      showToast(t("ssh.tmuxSessions.killDone", { name: session.name }));
      await load();
    } catch (err) {
      showToast(formatIpcError(err));
    } finally {
      setKilling(null);
    }
  };

  // 「进入」/「切换到 Tab」统一入口：
  // - 当前窗口已有该会话的 Tab：直接聚焦（无需建连，无 loading 态）
  // - 否则（其他窗口有 Tab 或完全无 Tab）：调 attachTmuxSession 建连并开新 Tab
  const handleEnter = async (session: TmuxSessionInfo) => {
    if (!connectionId) return;
    const firstTabId = firstTabIdBySession.get(session.name);
    if (firstTabId) {
      focusTerminalTab(firstTabId);
      return;
    }
    setAttaching(session.name);
    try {
      await attachTmuxSession(connectionId, session.name);
      // 开新 Tab 后立即刷新计数
      void unwrapCommand(commands.sshTmuxTabStats(connectionId))
        .then(setTabStats)
        .catch(() => {});
    } catch (err) {
      showToast(
        `${t("ssh.tmuxSessions.enterFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAttaching(null);
    }
  };

  return (
    <div className="tmux-sessions">
      <div className="tmux-sessions__header">
        <div className="tmux-sessions__intro">{t("ssh.tmuxSessions.intro")}</div>
        <div className="tmux-sessions__header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => connectionId && openSshTerminalSession(connectionId)}
            disabled={!connectionId}
          >
            {t("ssh.tmuxSessions.openTerminal")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void load()}
            disabled={loading || !connectionId}
          >
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {error ? <div className="tmux-sessions__error">{error}</div> : null}

      {loading && sessions.length === 0 ? (
        <div className="tmux-sessions__empty">{t("common.loading")}</div>
      ) : null}

      {!loading && !error && sessions.length === 0 ? (
        <div className="tmux-sessions__empty">{t("ssh.tmuxSessions.empty")}</div>
      ) : null}

      {sessions.length > 0 ? (
        <table className="tmux-sessions__table">
          <thead>
            <tr>
              <th>{t("ssh.tmuxSessions.name")}</th>
              <th>{t("ssh.tmuxSessions.windows")}</th>
              <th>{t("ssh.tmuxSessions.created")}</th>
              <th>{t("ssh.tmuxSessions.state")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const tabCount = tabCountBySession.get(session.name) ?? 0;
              const isLinked = tabCount > 0;
              return (
                <tr key={session.name}>
                  <td>
                    <span className="tmux-sessions__name">{session.name}</span>
                    {session.managed ? (
                      <span className="tmux-sessions__tag" title={t("ssh.tmuxSessions.managedHint")}>
                        {t("ssh.tmuxSessions.managed")}
                      </span>
                    ) : null}
                    {isLinked ? (
                      <span
                        className="tmux-sessions__tag tmux-sessions__tag--in-use"
                        title={t("ssh.tmuxSessions.linkedHint")}
                      >
                        {tabCount === 1
                          ? t("ssh.tmuxSessions.linked")
                          : t("ssh.tmuxSessions.linkedCount", { count: tabCount })}
                      </span>
                    ) : null}
                  </td>
                  <td>{session.windows}</td>
                  <td>{formatCreated(session.created)}</td>
                  <td>
                    {session.attached
                      ? t("ssh.tmuxSessions.attached")
                      : t("ssh.tmuxSessions.detached")}
                  </td>
                  <td className="tmux-sessions__actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-primary"
                      onClick={() => void handleEnter(session)}
                      disabled={attaching === session.name}
                    >
                      {attaching === session.name
                        ? t("ssh.tmuxSessions.enterBusy")
                        : isLinked
                          ? t("ssh.tmuxSessions.switchToTab")
                          : t("ssh.tmuxSessions.enter")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-danger"
                      onClick={() => void handleKill(session)}
                      disabled={killing === session.name}
                    >
                      {t("ssh.tmuxSessions.kill")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { commands, type TmuxSessionInfo, type TmuxTabStat, type TmuxWindowInfo } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import { isSshAuthHeld, noteSshAuthFailure } from "@/modules/server/ssh/sshAuthHold";
import { useI18n } from "@/i18n";
import { appConfirm } from "@/lib/appConfirm";
import {
  attachTmuxSession,
  attachTmuxSessionNewWindow,
  focusTerminalTab,
  openSshTerminalSession,
} from "@/lib/terminalSession";
import type { WorkspaceResource } from "@/lib/resourceRegistry";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { showToast } from "@/stores/toastStore";
import { isProdHost } from "@/modules/server/ssh/utils/sshProdGuard";
import { useTmuxPaneSessionIndex } from "@/modules/terminal/tmuxPaneSessionIndex";
import { WorkbenchActionButton } from "@/components/ui/primitives/WorkbenchActionButton";

type Props = {
  activeResource: WorkspaceResource | null;
};

function formatCreated(seconds: number | null): string {
  if (seconds == null || !seconds) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

function shortSessionLabel(name: string): string {
  if (!name.startsWith("omnipanel-")) return name;
  const rest = name.slice("omnipanel-".length);
  if (rest.length <= 28) return rest;
  return `${rest.slice(0, 14)}…${rest.slice(-10)}`;
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [windowsBySession, setWindowsBySession] = useState<Record<string, TmuxWindowInfo[]>>({});
  const [windowsLoading, setWindowsLoading] = useState<Record<string, boolean>>({});
  const [windowsError, setWindowsError] = useState<Record<string, string>>({});
  const connection = useConnectionStore((s) =>
    connectionId ? s.connections.find((c) => c.id === connectionId) : undefined,
  );
  const isProd = isProdHost(activeResource, connection);
  const paneBindings = useTmuxPaneSessionIndex((s) => s.bindings);

  const tabs = useTerminalStore((s) => s.tabs);

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

  const tabIdByPane = useMemo(() => {
    const map = new Map<string, string>();
    for (const tab of tabs) {
      const name = tab.session?.tmuxSession;
      const paneId = tab.session?.tmuxPaneId;
      if (!name || paneId == null) continue;
      if (tab.session?.resourceId !== connectionId) continue;
      if (tab.workspaceOnly) continue;
      map.set(`${name}::${paneId}`, tab.id);
    }
    return map;
  }, [tabs, connectionId]);

  const tabCountBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const stat of tabStats) {
      map.set(stat.sessionName, stat.tabCount);
    }
    return map;
  }, [tabStats]);

  const historyPaneSet = useMemo(() => {
    const set = new Set<string>();
    for (const b of paneBindings) {
      if (connectionId && b.resourceId === connectionId) {
        set.add(`${b.tmuxSession}::${b.paneId}`);
      }
    }
    return set;
  }, [paneBindings, connectionId]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    if (isSshAuthHeld(connectionId)) return;
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
      noteSshAuthFailure(connectionId, err);
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

  useEffect(() => {
    if (!connectionId) return;
    const refresh = () => {
      if (isSshAuthHeld(connectionId)) return;
      void unwrapCommand(commands.sshTmuxTabStats(connectionId))
        .then(setTabStats)
        .catch(() => {});
    };
    window.addEventListener("omnipanel-terminal-focus-tab", refresh);
    return () => window.removeEventListener("omnipanel-terminal-focus-tab", refresh);
  }, [connectionId]);

  const loadWindows = useCallback(
    async (sessionName: string) => {
      if (!connectionId) return;
      setWindowsLoading((prev) => ({ ...prev, [sessionName]: true }));
      setWindowsError((prev) => {
        const next = { ...prev };
        delete next[sessionName];
        return next;
      });
      try {
        const list = await unwrapCommand(
          commands.sshTmuxListWindows(connectionId, sessionName),
        );
        setWindowsBySession((prev) => ({ ...prev, [sessionName]: list }));
      } catch (err) {
        setWindowsError((prev) => ({
          ...prev,
          [sessionName]: formatIpcError(err),
        }));
        setWindowsBySession((prev) => ({ ...prev, [sessionName]: [] }));
      } finally {
        setWindowsLoading((prev) => ({ ...prev, [sessionName]: false }));
      }
    },
    [connectionId],
  );

  const toggleExpand = useCallback(
    (sessionName: string) => {
      setExpanded((prev) => {
        const nextOpen = !prev[sessionName];
        const next = { ...prev, [sessionName]: nextOpen };
        if (nextOpen && !windowsBySession[sessionName] && !windowsLoading[sessionName]) {
          void loadWindows(sessionName);
        }
        return next;
      });
    },
    [loadWindows, windowsBySession, windowsLoading],
  );

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
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[session.name];
        return next;
      });
      setWindowsBySession((prev) => {
        const next = { ...prev };
        delete next[session.name];
        return next;
      });
      await load();
    } catch (err) {
      showToast(formatIpcError(err));
    } finally {
      setKilling(null);
    }
  };

  const refreshTabStats = useCallback(() => {
    if (!connectionId) return;
    void unwrapCommand(commands.sshTmuxTabStats(connectionId))
      .then(setTabStats)
      .catch(() => {});
  }, [connectionId]);

  const handleEnterSession = async (session: TmuxSessionInfo) => {
    if (!connectionId) return;
    const firstTabId = firstTabIdBySession.get(session.name);
    if (firstTabId) {
      focusTerminalTab(firstTabId);
      return;
    }
    setAttaching(session.name);
    try {
      await attachTmuxSession(connectionId, session.name);
      refreshTabStats();
      if (expanded[session.name]) {
        void loadWindows(session.name);
      }
    } catch (err) {
      showToast(
        `${t("ssh.tmuxSessions.enterFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAttaching(null);
    }
  };

  const handleEnterPane = async (sessionName: string, paneId: number) => {
    if (!connectionId) return;
    const localTabId = tabIdByPane.get(`${sessionName}::${paneId}`);
    if (localTabId) {
      focusTerminalTab(localTabId);
      return;
    }
    const attachKey = `${sessionName}::${paneId}`;
    setAttaching(attachKey);
    try {
      await attachTmuxSession(connectionId, sessionName, 80, 24, paneId);
      refreshTabStats();
      void loadWindows(sessionName);
    } catch (err) {
      showToast(
        `${t("ssh.tmuxSessions.enterFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAttaching(null);
    }
  };

  const handleNewWindow = async (session: TmuxSessionInfo) => {
    if (!connectionId) return;
    setAttaching(`new:${session.name}`);
    try {
      await attachTmuxSessionNewWindow(connectionId, session.name);
      refreshTabStats();
      if (expanded[session.name]) {
        void loadWindows(session.name);
      }
      await load();
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
          <WorkbenchActionButton
            onClick={() => connectionId && openSshTerminalSession(connectionId)}
            disabled={!connectionId}
          >
            {t("ssh.tmuxSessions.openTerminal")}
          </WorkbenchActionButton>
          <WorkbenchActionButton
            onClick={() => void load()}
            disabled={loading || !connectionId}
          >
            {t("common.refresh")}
          </WorkbenchActionButton>
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
              const isOpen = Boolean(expanded[session.name]);
              const windows = windowsBySession[session.name] ?? [];
              const winLoading = Boolean(windowsLoading[session.name]);
              const winError = windowsError[session.name];
              return (
                <Fragment key={session.name}>
                  <tr className={isOpen ? "tmux-sessions__row--expanded" : undefined}>
                    <td>
                      <div className="tmux-sessions__name-cell">
                        <span className="tmux-sessions__name" title={session.name}>
                          {shortSessionLabel(session.name)}
                        </span>
                        {session.managed ? (
                          <span className="tmux-sessions__tag" title={t("ssh.tmuxSessions.managedHint")}>
                            {t("ssh.tmuxSessions.managed")}
                          </span>
                        ) : null}
                        {isLinked ? (
                          <span
                            className="tmux-sessions__tag tmux-sessions__tag--muted"
                            title={t("ssh.tmuxSessions.linkedHint")}
                          >
                            {tabCount === 1
                              ? t("ssh.tmuxSessions.linked")
                              : t("ssh.tmuxSessions.linkedCount", { count: tabCount })}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`tmux-sessions__expand${isOpen ? " is-open" : ""}`}
                        onClick={() => toggleExpand(session.name)}
                        aria-expanded={isOpen}
                        title={t("ssh.tmuxSessions.expandWindows")}
                      >
                        <span className="tmux-sessions__expand-chevron" aria-hidden>
                          ▸
                        </span>
                        <span className="tmux-sessions__expand-count">{session.windows}</span>
                      </button>
                    </td>
                    <td>{formatCreated(session.created)}</td>
                    <td>
                      {session.attached
                        ? t("ssh.tmuxSessions.attached")
                        : t("ssh.tmuxSessions.detached")}
                    </td>
                    <td className="tmux-sessions__actions">
                      <WorkbenchActionButton
                        onClick={() => void handleEnterSession(session)}
                        disabled={attaching === session.name}
                      >
                        {attaching === session.name
                          ? t("ssh.tmuxSessions.enterBusy")
                          : isLinked
                            ? t("ssh.tmuxSessions.switchToTab")
                            : t("ssh.tmuxSessions.enter")}
                      </WorkbenchActionButton>
                      <WorkbenchActionButton
                        danger
                        onClick={() => void handleKill(session)}
                        disabled={killing === session.name}
                      >
                        {t("ssh.tmuxSessions.kill")}
                      </WorkbenchActionButton>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="tmux-sessions__tree-row">
                      <td colSpan={5}>
                        <div className="tmux-sessions__tree">
                          {winLoading ? (
                            <div className="tmux-sessions__tree-status">{t("common.loading")}</div>
                          ) : null}
                          {winError ? (
                            <div className="tmux-sessions__tree-error">{winError}</div>
                          ) : null}
                          {!winLoading && !winError && windows.length === 0 ? (
                            <div className="tmux-sessions__tree-status">
                              {t("ssh.tmuxSessions.windowsEmpty")}
                            </div>
                          ) : null}
                          {windows.length > 0 ? (
                            <ul className="tmux-sessions__window-list">
                              {windows.map((win) => {
                                const paneKey = `${session.name}::${win.paneId}`;
                                const localTabId = tabIdByPane.get(paneKey);
                                const hasHistory = historyPaneSet.has(paneKey);
                                const busy = attaching === paneKey;
                                return (
                                  <li key={`${win.windowId}-${win.paneId}`} className="tmux-sessions__window">
                                    <div className="tmux-sessions__window-main">
                                      <span className="tmux-sessions__window-name" title={win.name || win.windowId}>
                                        {win.name?.trim() || win.windowId}
                                      </span>
                                      <span className="tmux-sessions__window-meta">
                                        {win.windowId} · %{win.paneId}
                                      </span>
                                      {localTabId ? (
                                        <span className="tmux-sessions__tag tmux-sessions__tag--muted">
                                          {t("ssh.tmuxSessions.windowLinked")}
                                        </span>
                                      ) : hasHistory ? (
                                        <span className="tmux-sessions__tag tmux-sessions__tag--muted">
                                          {t("ssh.tmuxSessions.windowHasHistory")}
                                        </span>
                                      ) : (
                                        <span className="tmux-sessions__tag tmux-sessions__tag--orphan">
                                          {t("ssh.tmuxSessions.windowOrphan")}
                                        </span>
                                      )}
                                    </div>
                                    <div className="tmux-sessions__window-actions">
                                      <WorkbenchActionButton
                                        disabled={busy}
                                        onClick={() => void handleEnterPane(session.name, win.paneId)}
                                      >
                                        {busy
                                          ? t("ssh.tmuxSessions.enterBusy")
                                          : localTabId
                                            ? t("ssh.tmuxSessions.switchToTab")
                                            : hasHistory
                                              ? t("ssh.tmuxSessions.restoreWindow")
                                              : t("ssh.tmuxSessions.enterWindow")}
                                      </WorkbenchActionButton>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                          <div className="tmux-sessions__tree-footer">
                            <WorkbenchActionButton
                              disabled={attaching === `new:${session.name}`}
                              onClick={() => void handleNewWindow(session)}
                            >
                              {attaching === `new:${session.name}`
                                ? t("ssh.tmuxSessions.enterBusy")
                                : t("ssh.tmuxSessions.newWindow")}
                            </WorkbenchActionButton>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

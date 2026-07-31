import { useCallback, useEffect, useState } from "react";

import { commands, type TmuxSessionInfo } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import { useI18n } from "@/i18n";
import { appConfirm } from "@/lib/appConfirm";
import { openSshTerminalSession } from "@/lib/terminalSession";
import type { WorkspaceResource } from "@/lib/resourceRegistry";
import { useConnectionStore } from "@/stores/connectionStore";
import { showToast } from "@/stores/toastStore";
import { isProdHost } from "@/modules/server/ssh/utils/sshProdGuard";

type Props = {
  activeResource: WorkspaceResource | null;
};

function formatCreated(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * 远端 tmux 会话治理视图。
 *
 * 走 exec 通道查询，因此不要求该主机当前打开着终端——遗留会话正是在没开终端时
 * 才需要被看见与清理。列表包含非本应用创建的会话，避免用户误以为「不是我建的就看不到」。
 */
export function TmuxSessionsDetailTab({ activeResource }: Props) {
  const { t } = useI18n();
  const connectionId = activeResource?.id ?? null;
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const connection = useConnectionStore((s) =>
    connectionId ? s.connections.find((c) => c.id === connectionId) : undefined,
  );
  const isProd = isProdHost(activeResource, connection);

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    try {
      setSessions(await unwrapCommand(commands.sshTmuxListSessions(connectionId)));
    } catch (err) {
      setError(formatIpcError(err));
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

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
            {sessions.map((session) => (
              <tr key={session.name}>
                <td>
                  <span className="tmux-sessions__name">{session.name}</span>
                  {session.managed ? (
                    <span className="tmux-sessions__tag" title={t("ssh.tmuxSessions.managedHint")}>
                      {t("ssh.tmuxSessions.managed")}
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
                    className="btn btn-ghost btn-sm btn-danger"
                    onClick={() => void handleKill(session)}
                    disabled={killing === session.name}
                  >
                    {t("ssh.tmuxSessions.kill")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

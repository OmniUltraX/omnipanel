import { useState } from "react";

import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { useTerminalBackendStateStore } from "../../stores/terminalBackendStateStore";
import { findTerminalPane, useTerminalStore } from "../../stores/terminalStore";
import { useTerminalTransportStore } from "../../stores/terminalTransportStore";

/** 默认会话名前缀，badge 显示时去掉以聚焦用户自定义会话或主机短名。 */
const TMUX_DEFAULT_SESSION_PREFIX = "omnipanel-";
/** badge 中会话名最大长度，超过截断加省略号，避免撑爆工具条。 */
const TMUX_SESSION_BADGE_MAX = 16;

/**
 * 把 tmux 会话名规整为 badge 内的短显示名。
 *
 * - `omnipanel-<host>` 默认会话去掉前缀，露出主机短名；
 * - 用户自定义会话名保持原样；
 * - 过长时按字符截断加 `…`。
 */
function shortSessionName(session: string | null): string | null {
  if (!session) return null;
  const trimmed = session.startsWith(TMUX_DEFAULT_SESSION_PREFIX)
    ? session.slice(TMUX_DEFAULT_SESSION_PREFIX.length)
    : session;
  if (trimmed.length <= TMUX_SESSION_BADGE_MAX) return trimmed;
  return `${trimmed.slice(0, TMUX_SESSION_BADGE_MAX - 1)}…`;
}

/**
 * 远程终端的传输模式标识。
 *
 * tmux 模式下可点击切换为直连（逃生阀）：远端 window 保留、其中的进程继续运行，
 * 只有这一个 Tab 改用独立连接，同主机其余 Tab 不受影响。
 */
export function TerminalTransportBadge({ paneId }: { paneId: string }) {
  const { t } = useI18n();
  const transport = useTerminalTransportStore((s) => s.transports[paneId]);
  const [busy, setBusy] = useState(false);

  if (!transport) return null;

  if (transport.mode === "direct") {
    return (
      <span
        className="term-transport-badge"
        title={
          transport.fallbackReason
            ? t("terminal.transport.directHintWithReason", { reason: transport.fallbackReason })
            : t("terminal.transport.directHint")
        }
      >
        {t("terminal.transport.direct")}
      </span>
    );
  }

  const handleSwitchToDirect = async () => {
    const pane = findTerminalPane(paneId);
    const backendSid = pane?.backendSessionId;
    if (!backendSid) {
      showToast(t("terminal.transport.switchUnavailable"));
      return;
    }
    const ok = await appConfirm(
      t("terminal.transport.switchConfirm"),
      t("terminal.transport.switchToDirect"),
      { kind: "warning", confirmLabel: t("terminal.transport.switchAction") },
    );
    if (!ok) return;

    setBusy(true);
    try {
      const cols = pane.terminal?.cols ?? 80;
      const rows = pane.terminal?.rows ?? 24;
      await unwrapCommand(commands.sshTerminalSetDirectMode(backendSid, cols, rows));
      // 新 shell 是全新进程，必须重新注入 OSC 133 钩子，否则 Blocks 会失效
      useTerminalBackendStateStore.getState().removeInjectedSession(backendSid);
      useTerminalTransportStore.getState().setTransport(paneId, {
        ...transport,
        mode: "direct",
        tmuxVersion: null,
        tmuxSession: null,
        tmuxPaneId: null,
        fallbackReason: t("terminal.transport.switchedByUser"),
      });
      // 切直连后 pane id 不再有意义，清掉持久化值避免下次重连误用
      useTerminalStore.getState().setSessionTmuxPaneId(paneId, null);
      // 后端会话 id 不变，重连只是让前端重新走一遍附着与注入流程
      useTerminalStore.getState().bumpReconnect(paneId);
      showToast(t("terminal.transport.switchDone"));
    } catch (err) {
      showToast(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const shortSession = shortSessionName(transport.tmuxSession);
  const label = shortSession
    ? t("terminal.transport.tmuxWithSession", { session: shortSession })
    : t("terminal.transport.tmux");

  return (
    <button
      type="button"
      className="term-transport-badge term-transport-badge--tmux"
      disabled={busy}
      onClick={() => void handleSwitchToDirect()}
      title={t("terminal.transport.tmuxHint", {
        version: transport.tmuxVersion ?? "",
        session: transport.tmuxSession ?? "",
      })}
    >
      {label}
    </button>
  );
}

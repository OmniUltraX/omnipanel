import { useState } from "react";

import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { useTerminalBackendStateStore } from "../../stores/terminalBackendStateStore";
import { findTerminalPane, useTerminalStore } from "../../stores/terminalStore";
import { useTerminalTransportStore } from "../../stores/terminalTransportStore";

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
        fallbackReason: t("terminal.transport.switchedByUser"),
      });
      // 后端会话 id 不变，重连只是让前端重新走一遍附着与注入流程
      useTerminalStore.getState().bumpReconnect(paneId);
      showToast(t("terminal.transport.switchDone"));
    } catch (err) {
      showToast(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  };

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
      {t("terminal.transport.tmux")}
    </button>
  );
}

import { useCallback, useMemo } from "react";
import { startTransition } from "react";
import {
  resolveResourceById,
} from "../../stores/connectionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminalLeftPanelStore } from "./terminalLeftPanelStore";import { useI18n } from "../../i18n";
import { requestTerminalExecution } from "./executeTerminalCommand";
import { tryOpenSshFromTerminalCommand } from "./openSshFromTerminalCommand";
import { registerUserShellCommand } from "./postShellAiTrigger";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import {
  setTerminalPaneSender,
} from "./terminalPaneSenders";

export function useTerminalTabDockPane(
  tabId: string,
  isActive: boolean,
  onActivate?: () => void,
) {
  const { t } = useI18n();
  const tab = useTerminalStore((state) => {
    for (const item of state.tabs) {
      if (item.id === tabId) return item;
    }
    return null;
  });  const resource = useMemo(
    () => resolveResourceById(tab?.session.resourceId ?? null) ?? null,
    [tab?.session.resourceId],
  );

  const handleSenderChange = useCallback(
    (sessionId: string, sender: ((cmd: string) => void) | null) => {
      setTerminalPaneSender(sessionId, sender);
    },
    [],
  );

  const handleSendCommand = useCallback(
    (command: string) => {
      if (!tab) return;
      void tryOpenSshFromTerminalCommand(
        command,
        {
          openedExisting: (name) =>
            t("terminal.command.sshOpenedExisting", { name }),
          openedNew: (name) => t("terminal.command.sshOpenedNew", { name }),
          saveFailed: t("terminal.command.sshOpenFailed"),
          connectFailed: t("terminal.command.sshConnectFailed"),
          authFailed: t("terminal.command.sshAuthFailed"),
          passwordPromptTitle: t("terminal.command.sshPasswordPromptTitle"),
          passwordPromptSubtitle: (name) =>
            t("terminal.command.sshPasswordPromptSubtitle", { name }),
          passwordPromptPlaceholder: t("terminal.command.sshPasswordPromptPlaceholder"),
          passwordRequired: t("terminal.command.sshPasswordRequired"),
          passwordCancelled: t("terminal.command.sshPasswordCancelled"),
        },
        { sourceSessionId: tabId },
      ).then((handled) => {
        if (handled) return;
        registerUserShellCommand(tabId, command);
        const targetResource =
          resolveResourceById(tab.session.resourceId) ??
          resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);
        requestTerminalExecution({
          tabId,
          command,
          resourceId: targetResource?.id ?? tab.session.resourceId,
          source: "用户",
          title: t("terminal.actions.command"),
          description: `${tab.title} · ${command}`,
        });
      });
    },
    [tab, tabId, t],
  );

  const handleActivate = useCallback(() => {
    if (onActivate) {
      onActivate();
      return;
    }
    useTerminalLeftPanelStore.getState().focusSessions();
    startTransition(() => {
      useTerminalStore.getState().setActiveTab(tabId);
    });
  }, [onActivate, tabId]);

  return {
    tab,
    resource,
    paneProps: tab
      ? {
          paneId: tab.id,
          tab,
          resource,
          isActive,
          onActivate: handleActivate,
          onSendCommand: handleSendCommand,
          onSenderChange: handleSenderChange,
        }
      : null,
  };
}

import { useCallback, useMemo } from "react";
import {
  resolveResourceById,
} from "../../stores/connectionStore";
import { useActionStore } from "../../stores/actionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useI18n } from "../../i18n";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import {
  setTerminalPaneSender,
  terminalPaneSenders,
} from "./terminalPaneSenders";

export function useTerminalTabDockPane(
  tabId: string,
  isActive: boolean,
  onActivate?: () => void,
) {
  const { t } = useI18n();
  const tabs = useTerminalStore((state) => state.tabs);
  const enqueueAction = useActionStore((state) => state.enqueueAction);

  const tab = useMemo(
    () => tabs.find((item) => item.id === tabId) ?? null,
    [tabs, tabId],
  );
  const resource = useMemo(
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
      terminalPaneSenders[tabId]?.(command);
      if (!tab) return;
      const targetResource =
        resolveResourceById(tab.session.resourceId) ??
        resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);
      enqueueAction({
        type: "terminal",
        title: t("terminal.actions.command"),
        description: `${tab.title} · ${command}`,
        command,
        resourceId: targetResource?.id ?? tab.session.resourceId,
        source: "用户",
      });
    },
    [enqueueAction, tab, tabId, t],
  );

  const handleActivate = useCallback(() => {
    onActivate?.();
  }, [onActivate]);

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

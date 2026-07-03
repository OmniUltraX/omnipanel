import { useMemo } from "react";
import { useI18n } from "../../i18n";
import {
  getVisibleProtocolTabs,
  isDevLockedProtocolTab,
} from "../../lib/protocolLabConfig";
import type { TopbarAddMenuItem } from "../../stores/topbarStore";
import { useSettingsStore } from "../../stores/settingsStore";

export function useProtocolAddMenu() {
  const { t } = useI18n();
  const protocolLabTabs = useSettingsStore((s) => s.protocolLabTabs);

  const selectableProtocols = useMemo(
    () => getVisibleProtocolTabs(protocolLabTabs),
    [protocolLabTabs],
  );

  const menuItems = useMemo((): TopbarAddMenuItem[] => {
    return selectableProtocols.map((protocol) => ({
      id: protocol,
      label: t(`protocol.tabs.${protocol}`),
      subtitle: isDevLockedProtocolTab(protocol)
        ? t("protocol.newTab.devLocked")
        : t(`protocol.newTab.hint.${protocol}`),
    }));
  }, [selectableProtocols, t]);

  return {
    menuItems,
    selectableProtocols,
  };
}

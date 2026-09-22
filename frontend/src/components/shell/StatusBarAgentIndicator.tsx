import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { getAgentAdapter } from "../../lib/agents/registry";
import { statusByKind } from "../../lib/agents/detect";
import { isSupportedAgentKind } from "../../lib/agents/types";
import {
  cliProviderOnlineStatusLabelKey,
  getCliProviderModels,
  resolveAgentOnlineStatus,
  useCliProvidersStore,
} from "../../stores/cliProvidersStore";
import { useAcpServicesStore } from "../../stores/acpServicesStore";
import { useSettingsUiStore } from "../../stores/settingsUiStore";

/** 状态栏右下：当前智能体名称 + 连接状态（与设置页 Agents 同一套推导）。 */
export function StatusBarAgentIndicator() {
  const { t } = useI18n();
  const providers = useCliProvidersStore((s) => s.providers);
  const modelCache = useCliProvidersStore((s) => s.modelCache);
  const onlineStatusById = useCliProvidersStore((s) => s.onlineStatusById);
  const refreshingModelIds = useCliProvidersStore((s) => s.refreshingModelIds);
  const installStatuses = useAcpServicesStore((s) => s.installStatuses);
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  const active = useMemo(
    () => providers.find((p) => Boolean(p.enabled)) ?? null,
    [providers],
  );

  const installStatus = useMemo(() => {
    if (!active || !isSupportedAgentKind(active.id)) return undefined;
    return statusByKind(installStatuses, active.id);
  }, [active, installStatuses]);

  const installed = installStatus
    ? installStatus.installed
    : Boolean(active?.binary?.trim());

  const modelCount = active
    ? getCliProviderModels(active, modelCache).length
    : 0;

  const status = active
    ? resolveAgentOnlineStatus(
        active.id,
        installed,
        Boolean(active.enabled),
        onlineStatusById[active.id],
        Boolean(refreshingModelIds[active.id]),
        modelCount,
      )
    : "idle";

  const agentName = active
    ? isSupportedAgentKind(active.id)
      ? t(getAgentAdapter(active.id).nameKey)
      : active.displayName.trim() || active.id
    : null;

  const statusText = active
    ? t(cliProviderOnlineStatusLabelKey(status))
    : t("settings.cliProviders.noneEnabled");

  const title = active ? `${agentName} · ${statusText}` : statusText;

  return (
    <button
      type="button"
      className={`statusbar-item statusbar-button statusbar-agent statusbar-agent--${status}${
        active ? "" : " statusbar-agent--empty"
      }`}
      title={title}
      aria-label={title}
      onClick={() => openSettings("ai")}
    >
      {agentName ? (
        <span className="statusbar-agent__name">{agentName}</span>
      ) : null}
      <span className="statusbar-agent__status">{statusText}</span>
    </button>
  );
}

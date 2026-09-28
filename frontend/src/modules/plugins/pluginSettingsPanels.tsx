import type { ReactNode } from "react";
import { WarpgateGatewaysPanel } from "../server/ssh/components/WarpgateGatewaysPanel";

/** 自定义设置面板把主操作报到 SubWindow 底栏，避免滚出视野。 */
export type PluginSettingsPanelActions = {
  primaryLabel: string;
  onPrimary: () => void;
  busy?: boolean;
  disabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
};

export type PluginSettingsPanelOptions = {
  onActionsChange?: (actions: PluginSettingsPanelActions | null) => void;
};

/**
 * 宿主内置插件设置面板（manifest `contributes.configuration.panel`）。
 * 新面板在此登记，禁止在列表行按 pluginId 特判。
 */
const PANELS: Record<
  string,
  (pluginId: string, options?: PluginSettingsPanelOptions) => ReactNode
> = {
  "warpgate.gateways": (_pluginId, options) => (
    <WarpgateGatewaysPanel embedded onActionsChange={options?.onActionsChange} />
  ),
};

export function renderPluginSettingsPanel(
  panelId: string | undefined,
  pluginId: string,
  options?: PluginSettingsPanelOptions,
): ReactNode {
  if (!panelId?.trim()) return null;
  const render = PANELS[panelId.trim()];
  return render ? render(pluginId, options) : null;
}

export function isKnownPluginSettingsPanel(panelId: string | undefined): boolean {
  return Boolean(panelId?.trim() && PANELS[panelId.trim()]);
}

import { useCallback, useEffect, useMemo } from "react";

import { useI18n } from "../../i18n";
import type { ModuleKey } from "../../lib/paths";
import { isModuleOpen, useAppModuleStore } from "../../stores/appModuleStore";
import { useBuiltinToolStore } from "../../stores/builtinToolStore";
import { useWebSearchStore } from "../../stores/webSearchStore";

function SettingToggle({
  value,
  onChange,
  disabled,
  label,
  compact = false,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`setting-toggle-group${compact ? " setting-toggle-group--compact" : ""}`}
      title={label}
    >
      {!compact ? <span className="setting-toggle-label">{label}</span> : null}
      <div
        className={`toggle ${value ? "on" : ""}${disabled ? " toggle--disabled" : ""}`}
        role="switch"
        aria-checked={value}
        aria-label={label}
        aria-disabled={disabled}
        onClick={() => !disabled && onChange(!value)}
        style={{ cursor: disabled ? "not-allowed" : "pointer" }}
      />
    </div>
  );
}

const MODULE_LABEL_KEYS: Record<string, string> = {
  terminal: "routes.terminal",
  database: "routes.database",
  ssh: "routes.ssh",
  docker: "routes.docker",
  server: "routes.server",
  files: "routes.files",
  protocol: "routes.protocol",
  workflow: "routes.workflow",
  knowledge: "routes.knowledge",
};

/** 设置页「全局工具」分组（module_key = web） */
function isGlobalWebTool(moduleKey: string): boolean {
  return moduleKey === "web";
}

/** 仅联网搜索相关工具受「Web 搜索」总开关隐藏；Skill/Tag/Resource 等全局工具始终展示 */
function isWebSearchGatedTool(toolName: string): boolean {
  return (
    toolName === "omni_web_search" ||
    toolName === "omni_zhihu_search" ||
    toolName === "omni_web_fetch"
  );
}

function moduleLabelKey(moduleKey: string): string {
  if (isGlobalWebTool(moduleKey)) return "settings.builtinTools.global";
  return MODULE_LABEL_KEYS[moduleKey] ?? moduleKey;
}

function isToolActionable(moduleKey: string): boolean {
  if (isGlobalWebTool(moduleKey)) return true;
  return isModuleOpen(moduleKey as ModuleKey);
}

/** OmniMCP 对外暴露：全部内置工具均可配置，按模块分组。 */
export function OmniMcpToolsExposureSection() {
  const { t } = useI18n();
  const tools = useBuiltinToolStore((s) => s.tools);
  const hydrate = useBuiltinToolStore((s) => s.hydrate);
  const setExternalExposed = useBuiltinToolStore((s) => s.setExternalExposed);
  const modules = useAppModuleStore((s) => s.modules);
  const webSearchConfig = useWebSearchStore((s) => s.config);
  const hydrateWebSearch = useWebSearchStore((s) => s.hydrate);
  const webSearchEnabled = webSearchConfig?.enabled ?? false;

  useEffect(() => {
    if (tools.length === 0) {
      void hydrate();
    }
  }, [hydrate, tools.length, modules]);

  useEffect(() => {
    if (!webSearchConfig) {
      void hydrateWebSearch();
    }
  }, [hydrateWebSearch, webSearchConfig]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof tools>();
    for (const tool of tools) {
      if (isWebSearchGatedTool(tool.tool_name) && !webSearchEnabled) continue;
      const list = map.get(tool.module_key) ?? [];
      list.push(tool);
      map.set(tool.module_key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, webSearchEnabled]);

  const handleExternalToggle = useCallback(
    async (toolName: string, moduleKey: string, exposed: boolean) => {
      if (!isToolActionable(moduleKey)) return;
      await setExternalExposed(toolName, exposed);
    },
    [setExternalExposed],
  );

  if (grouped.length === 0) {
    return <p className="setting-hint">{t("settings.aiServices.omnimcp.toolsEmpty")}</p>;
  }

  return (
    <>
      <div className="setting-row builtin-tools-column-header">
        <div className="setting-label" aria-hidden="true" />
        <div className="setting-row-toggles setting-row-toggles--single">
          <span className="setting-toggle-label">{t("settings.builtinTools.external")}</span>
        </div>
      </div>
      {grouped.map(([moduleKey, moduleTools], index) => {
        const actionable = isToolActionable(moduleKey);
        return (
          <div key={moduleKey}>
            {index > 0 ? <div className="settings-section-divider" /> : null}
            <div className="settings-subsection-title">
              {t(moduleLabelKey(moduleKey) as "settings.builtinTools.global")}
            </div>
            {!actionable ? (
              <p className="setting-hint settings-subsection-desc">
                {t("settings.builtinTools.moduleClosedDesc")}
              </p>
            ) : (
              <p className="setting-hint settings-subsection-desc">
                {t("settings.builtinTools.moduleDesc", { count: moduleTools.length })}
              </p>
            )}
            {moduleTools.map((tool) => (
              <div className="setting-row" key={tool.tool_name}>
                <div className="setting-label">
                  <h4 className="mcp-tool-name" title={tool.tool_name}>
                    {tool.tool_name}
                  </h4>
                  {tool.description ? <p>{tool.description}</p> : null}
                </div>
                <div className="setting-row-toggles setting-row-toggles--single">
                  <SettingToggle
                    label={t("settings.builtinTools.external")}
                    value={actionable && tool.external_exposed}
                    disabled={!actionable}
                    compact
                    onChange={(v) => void handleExternalToggle(tool.tool_name, moduleKey, v)}
                  />
                </div>
              </div>
            ))}
          </div>
        );
      })}
      <p className="setting-hint settings-subsection-desc">
        {t("settings.aiServices.omnimcp.toolsUiDelegatedHint")}
      </p>
    </>
  );
}

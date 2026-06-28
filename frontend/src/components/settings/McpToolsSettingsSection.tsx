import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "../../i18n";
import type { ModuleKey } from "../../lib/paths";
import { isModuleOpen, useAppModuleStore } from "../../stores/appModuleStore";
import { useMcpToolStore } from "../../stores/mcpToolStore";

function SettingToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`toggle ${value ? "on" : ""}${disabled ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={value}
      aria-disabled={disabled}
      onClick={() => !disabled && onChange(!value)}
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    />
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

function moduleLabelKey(moduleKey: string): string {
  return MODULE_LABEL_KEYS[moduleKey] ?? moduleKey;
}

export function McpToolsSettingsSection() {
  const { t } = useI18n();
  const tools = useMcpToolStore((s) => s.tools);
  const hydrate = useMcpToolStore((s) => s.hydrate);
  const setEnabled = useMcpToolStore((s) => s.setEnabled);
  const modules = useAppModuleStore((s) => s.modules);

  useEffect(() => {
    if (tools.length === 0) {
      void hydrate();
    }
  }, [hydrate, tools.length, modules]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof tools>();
    for (const tool of tools) {
      const list = map.get(tool.module_key) ?? [];
      list.push(tool);
      map.set(tool.module_key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools]);

  const handleToggle = useCallback(
    async (toolName: string, moduleKey: string, enabled: boolean) => {
      if (!isModuleOpen(moduleKey as ModuleKey)) return;
      await setEnabled(toolName, enabled);
    },
    [setEnabled],
  );

  if (tools.length === 0) {
    return <p className="setting-hint">{t("settings.mcpTools.empty")}</p>;
  }

  return (
    <>
      {grouped.map(([moduleKey, moduleTools], index) => {
        const moduleOpen = isModuleOpen(moduleKey as ModuleKey);
        return (
          <div key={moduleKey}>
            {index > 0 ? <div className="settings-section-divider" /> : null}
            <div className="settings-subsection-title">{t(moduleLabelKey(moduleKey) as `routes.${ModuleKey}`)}</div>
            {!moduleOpen ? (
              <p className="setting-hint settings-subsection-desc">
                {t("settings.mcpTools.moduleClosedDesc")} {t("settings.mcpTools.moduleSyncHint")}
              </p>
            ) : (
              <p className="setting-hint settings-subsection-desc">
                {t("settings.mcpTools.moduleDesc", { count: moduleTools.length })}
              </p>
            )}
            {moduleTools.map((tool) => {
              const displayEnabled = moduleOpen && tool.enabled;
              return (
                <div className="setting-row" key={tool.tool_name}>
                  <div className="setting-label">
                    <h4 className="mcp-tool-name" title={tool.tool_name}>
                      {tool.tool_name}
                    </h4>
                    {tool.description ? <p>{tool.description}</p> : null}
                  </div>
                  <SettingToggle
                    value={displayEnabled}
                    disabled={!moduleOpen}
                    onChange={(v) => void handleToggle(tool.tool_name, moduleKey, v)}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

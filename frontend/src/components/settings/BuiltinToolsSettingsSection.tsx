import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "../../i18n";
import type { ModuleKey } from "../../lib/paths";
import { isModuleOpen, useAppModuleStore } from "../../stores/appModuleStore";
import { useBuiltinToolStore } from "../../stores/builtinToolStore";
import { useWebSearchStore } from "../../stores/webSearchStore";

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

/** Web 搜索工具归入「全局」，不依赖侧栏模块开关 */
function isGlobalWebTool(moduleKey: string): boolean {
  return moduleKey === "web";
}

function moduleLabelKey(moduleKey: string): string {
  if (isGlobalWebTool(moduleKey)) return "settings.builtinTools.global";
  return MODULE_LABEL_KEYS[moduleKey] ?? moduleKey;
}

function ActionCheckbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={`builtin-tools-table__check${disabled ? " is-disabled" : ""}`}
      title={label}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function isToolActionable(moduleKey: string): boolean {
  if (isGlobalWebTool(moduleKey)) return true;
  return isModuleOpen(moduleKey as ModuleKey);
}

export function BuiltinToolsSettingsSection() {
  const { t } = useI18n();
  const tools = useBuiltinToolStore((s) => s.tools);
  const hydrate = useBuiltinToolStore((s) => s.hydrate);
  const setInternalEnabled = useBuiltinToolStore((s) => s.setInternalEnabled);
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

  const rows = useMemo(
    () =>
      [...tools]
        .filter((tool) => !isGlobalWebTool(tool.module_key) || webSearchEnabled)
        .sort((a, b) => {
          const byModule = a.module_key.localeCompare(b.module_key);
          if (byModule !== 0) return byModule;
          return a.tool_name.localeCompare(b.tool_name);
        }),
    [tools, webSearchEnabled],
  );

  const hasClosedModule = useMemo(
    () =>
      rows.some(
        (tool) => !isGlobalWebTool(tool.module_key) && !isModuleOpen(tool.module_key as ModuleKey),
      ),
    [rows],
  );

  const handleInternalToggle = useCallback(
    async (toolName: string, moduleKey: string, enabled: boolean) => {
      if (!isToolActionable(moduleKey)) return;
      await setInternalEnabled(toolName, enabled);
    },
    [setInternalEnabled],
  );

  const handleExternalToggle = useCallback(
    async (toolName: string, moduleKey: string, exposed: boolean) => {
      if (!isToolActionable(moduleKey)) return;
      await setExternalExposed(toolName, exposed);
    },
    [setExternalExposed],
  );

  if (rows.length === 0) {
    return <p className="setting-hint">{t("settings.builtinTools.empty")}</p>;
  }

  return (
    <>
      {hasClosedModule ? (
        <p className="setting-hint settings-subsection-desc">
          {t("settings.builtinTools.moduleClosedDesc")}{" "}
          {t("settings.builtinTools.moduleSyncHint")}
        </p>
      ) : null}
      <div className="builtin-tools-table-wrap">
        <table className="builtin-tools-table">
          <colgroup>
            <col className="builtin-tools-table__col-module" />
            <col className="builtin-tools-table__col-name" />
            <col className="builtin-tools-table__col-desc" />
            <col className="builtin-tools-table__col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t("settings.builtinTools.colModule")}</th>
              <th scope="col">{t("settings.builtinTools.colName")}</th>
              <th scope="col">{t("settings.builtinTools.colDescription")}</th>
              <th scope="col">{t("settings.builtinTools.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tool) => {
              const actionable = isToolActionable(tool.module_key);
              const displayInternal = actionable && tool.internal_enabled;
              const displayExternal = actionable && tool.external_exposed;
              return (
                <tr
                  key={tool.tool_name}
                  className={actionable ? undefined : "builtin-tools-table__row--disabled"}
                >
                  <td className="builtin-tools-table__module">
                    {t(moduleLabelKey(tool.module_key) as "settings.builtinTools.global")}
                  </td>
                  <td className="builtin-tools-table__name" title={tool.tool_name}>
                    <code className="mcp-tool-name">{tool.tool_name}</code>
                  </td>
                  <td
                    className="builtin-tools-table__desc"
                    title={tool.description?.trim() ? tool.description : undefined}
                  >
                    <span className="builtin-tools-table__desc-text">
                      {tool.description || "—"}
                    </span>
                  </td>
                  <td className="builtin-tools-table__col-actions">
                    <div className="builtin-tools-table__actions">
                      <ActionCheckbox
                        label={t("settings.builtinTools.enable")}
                        checked={displayInternal}
                        disabled={!actionable}
                        onChange={(v) =>
                          void handleInternalToggle(tool.tool_name, tool.module_key, v)
                        }
                      />
                      <ActionCheckbox
                        label={t("settings.builtinTools.expose")}
                        checked={displayExternal}
                        disabled={!actionable}
                        onChange={(v) =>
                          void handleExternalToggle(tool.tool_name, tool.module_key, v)
                        }
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

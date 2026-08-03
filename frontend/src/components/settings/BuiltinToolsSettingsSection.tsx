import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { getAgentDefinition, type AgentId } from "../../lib/ai/agents";
import type { ModuleKey } from "../../lib/paths";
import { isModuleOpen, useAppModuleStore } from "../../stores/appModuleStore";
import { useBuiltinToolStore } from "../../stores/builtinToolStore";
import { useWebSearchStore } from "../../stores/webSearchStore";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";

/** 与 Agent 注册表 / 运行时注入一致的模块过滤 */
type AgentToolsScope =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "module"; moduleKey: string }
  | { mode: "allowlist"; moduleKey?: string; toolNames: Set<string> };

function toolsScopeForAgent(agentId: AgentId): AgentToolsScope {
  const policy = getAgentDefinition(agentId).tools;
  if (policy.kind === "none") return { mode: "none" };
  if (policy.kind === "allowlist") {
    return {
      mode: "allowlist",
      moduleKey:
        policy.moduleFilter && policy.moduleFilter !== "master"
          ? policy.moduleFilter
          : undefined,
      toolNames: new Set(policy.toolNames),
    };
  }
  if (policy.moduleFilter === "master") return { mode: "all" };
  return { mode: "module", moduleKey: policy.moduleFilter };
}

function toolMatchesScope(
  tool: { module_key: string; tool_name: string },
  scope: AgentToolsScope,
): boolean {
  if (scope.mode === "all") return true;
  if (scope.mode === "none") return false;
  if (scope.mode === "module") return tool.module_key === scope.moduleKey;
  if (!scope.toolNames.has(tool.tool_name)) return false;
  if (scope.moduleKey) return tool.module_key === scope.moduleKey;
  return true;
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

export function BuiltinToolsSettingsSection({ agentId }: { agentId: AgentId }) {
  const { t } = useI18n();
  const tools = useBuiltinToolStore((s) => s.tools);
  const hydrate = useBuiltinToolStore((s) => s.hydrate);
  const setInternalEnabled = useBuiltinToolStore((s) => s.setInternalEnabled);
  const setExternalExposed = useBuiltinToolStore((s) => s.setExternalExposed);
  const modulesState = useAppModuleStore((s) => s.modules);
  const webSearchConfig = useWebSearchStore((s) => s.config);
  const hydrateWebSearch = useWebSearchStore((s) => s.hydrate);
  const webSearchEnabled = webSearchConfig?.enabled ?? false;
  const [selectedModule, setSelectedModule] = useState<string | null>(null);

  const scope = useMemo(() => toolsScopeForAgent(agentId), [agentId]);

  useEffect(() => {
    if (tools.length === 0) {
      void hydrate();
    }
  }, [hydrate, tools.length, modulesState]);

  useEffect(() => {
    if (!webSearchConfig) {
      void hydrateWebSearch();
    }
  }, [hydrateWebSearch, webSearchConfig]);

  const rows = useMemo(
    () =>
      [...tools]
        .filter(
          (tool) =>
            toolMatchesScope(tool, scope) &&
            (!isWebSearchGatedTool(tool.tool_name) || webSearchEnabled),
        )
        .sort((a, b) => {
          const byModule = a.module_key.localeCompare(b.module_key);
          if (byModule !== 0) return byModule;
          return a.tool_name.localeCompare(b.tool_name);
        }),
    [tools, webSearchEnabled, scope],
  );

  const moduleKeys = useMemo(() => {
    const keys = Array.from(new Set(rows.map((tool) => tool.module_key)));
    keys.sort((a, b) => {
      if (isGlobalWebTool(a) !== isGlobalWebTool(b)) {
        return isGlobalWebTool(a) ? -1 : 1;
      }
      return a.localeCompare(b);
    });
    return keys;
  }, [rows]);

  /** 执行助手(master)等多模块时保留侧栏；单模块智能体直接出表 */
  const showModuleSidebar = moduleKeys.length > 1;

  const moduleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of rows) {
      counts.set(tool.module_key, (counts.get(tool.module_key) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  useEffect(() => {
    setSelectedModule(null);
  }, [agentId]);

  useEffect(() => {
    if (moduleKeys.length === 0) {
      setSelectedModule(null);
      return;
    }
    if (!showModuleSidebar) {
      setSelectedModule(moduleKeys[0] ?? null);
      return;
    }
    if (selectedModule && moduleKeys.includes(selectedModule)) {
      return;
    }
    setSelectedModule(moduleKeys[0] ?? null);
  }, [moduleKeys, selectedModule, showModuleSidebar]);

  const selectedRows = useMemo(() => {
    if (!showModuleSidebar) return rows;
    return selectedModule
      ? rows.filter((tool) => tool.module_key === selectedModule)
      : [];
  }, [rows, selectedModule, showModuleSidebar]);

  const selectedModuleClosed =
    selectedModule != null &&
    !isGlobalWebTool(selectedModule) &&
    !isModuleOpen(selectedModule as ModuleKey);

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
    return (
      <div className="settings-subsection skills-section">
        <p className="setting-hint">{t("settings.builtinTools.empty")}</p>
      </div>
    );
  }

  const toolsTable = (
    <>
      {selectedModuleClosed ? (
        <p className="setting-hint settings-subsection-desc">
          {t("settings.builtinTools.moduleClosedDesc")}{" "}
          {t("settings.builtinTools.moduleSyncHint")}
        </p>
      ) : null}
      <div className="builtin-tools-table-wrap">
        <table className="builtin-tools-table">
          <colgroup>
            <col className="builtin-tools-table__col-name" />
            <col className="builtin-tools-table__col-desc" />
            <col className="builtin-tools-table__col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t("settings.builtinTools.colName")}</th>
              <th scope="col">{t("settings.builtinTools.colDescription")}</th>
              <th scope="col">{t("settings.builtinTools.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {selectedRows.map((tool) => {
              const actionable = isToolActionable(tool.module_key);
              const displayInternal = actionable && tool.internal_enabled;
              const displayExternal = actionable && tool.external_exposed;
              return (
                <tr
                  key={tool.tool_name}
                  className={
                    actionable ? undefined : "builtin-tools-table__row--disabled"
                  }
                >
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
                          void handleInternalToggle(
                            tool.tool_name,
                            tool.module_key,
                            v,
                          )
                        }
                      />
                      <ActionCheckbox
                        label={t("settings.builtinTools.expose")}
                        checked={displayExternal}
                        disabled={!actionable}
                        onChange={(v) =>
                          void handleExternalToggle(
                            tool.tool_name,
                            tool.module_key,
                            v,
                          )
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

  return (
    <div className="settings-subsection skills-section builtin-tools-section">
      {showModuleSidebar ? (
        <div className="skills-layout">
          <aside
            className="skills-sidebar"
            aria-label={t("settings.builtinTools.sidebarTitle")}
          >
            <ul className="skills-sidebar-list">
              {moduleKeys.map((moduleKey) => {
                const active = moduleKey === selectedModule;
                const closed =
                  !isGlobalWebTool(moduleKey) && !isModuleOpen(moduleKey as ModuleKey);
                const count = moduleCounts.get(moduleKey) ?? 0;
                return (
                  <li key={moduleKey} className="skills-sidebar-row">
                    <button
                      type="button"
                      className={`skills-sidebar-item${active ? " is-active" : ""}${
                        closed ? " is-disabled" : ""
                      }`}
                      onClick={() => setSelectedModule(moduleKey)}
                    >
                      <span className="skills-sidebar-item__name">
                        {t(moduleLabelKey(moduleKey))}
                      </span>
                      <span className="skills-sidebar-item__meta">
                        <span className="builtin-tools-sidebar-count">{count}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="skills-content builtin-tools-content">
            {!selectedModule ? (
              <ModuleEmptyState title={t("settings.builtinTools.selectHint")} />
            ) : (
              toolsTable
            )}
          </div>
        </div>
      ) : (
        <div className="skills-content builtin-tools-content builtin-tools-content--solo">
          {toolsTable}
        </div>
      )}
    </div>
  );
}

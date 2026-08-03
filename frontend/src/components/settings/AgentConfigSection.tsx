import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import { commands, type AgentPromptEntry } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { ALL_AGENT_IDS, getAgentDefinition, isAgentId, type AgentId } from "../../lib/ai/agents";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { BuiltinToolsSettingsSection } from "./BuiltinToolsSettingsSection";
import { McpServicesSection } from "./McpServicesSection";
import { SkillsSection } from "./SkillsSection";
import { WebSearchSettingsSection } from "./WebSearchSettingsSection";
import { HarnessInventoryPanel } from "./HarnessInventoryPanel";

export type AgentConfigTab =
  | "prompts"
  | "harness"
  | "skills"
  | "builtin"
  | "webSearch"
  | "externalMcp";

const AGENT_CONFIG_TABS: { id: AgentConfigTab; labelKey: string }[] = [
  { id: "prompts", labelKey: "settings.agent.tabPrompts" },
  { id: "harness", labelKey: "settings.agent.tabHarness" },
  { id: "skills", labelKey: "settings.agent.tabSkills" },
  { id: "builtin", labelKey: "settings.agent.tabBuiltin" },
  { id: "webSearch", labelKey: "settings.agent.tabWebSearch" },
  { id: "externalMcp", labelKey: "settings.agent.tabExternalMcp" },
];

function agentLabelKey(id: string): string {
  return isAgentId(id) ? `ai.agents.${id}.label` : "settings.agent.prompts.unknown";
}

function agentDescKey(id: string): string {
  return isAgentId(id) ? `ai.agents.${id}.description` : "settings.agent.prompts.systemDesc";
}

function PromptEditor({
  entry,
  onSaved,
  compactHeader = false,
}: {
  entry: AgentPromptEntry;
  onSaved: (next: AgentPromptEntry) => void;
  /** 智能体配置页页头已展示名称时，内容区不再重复标题 */
  compactHeader?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(entry.content);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== entry.content;

  useEffect(() => {
    setDraft(entry.content);
  }, [entry.content, entry.id]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await commands.agentPromptSave(entry.id, draft);
      if (res.status === "ok") {
        onSaved(res.data);
        showToast(t("settings.agent.prompts.saveSuccess"));
      } else {
        showToast(
          typeof res.error === "string" ? res.error : t("settings.agent.prompts.saveFailed"),
        );
      }
    } catch (e) {
      showToast(String(e) || t("settings.agent.prompts.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [draft, entry.id, onSaved, t]);

  const handleReset = useCallback(async () => {
    const ok = await appConfirm(
      t("settings.agent.prompts.resetConfirm"),
      t("settings.agent.prompts.resetTitle"),
      { confirmLabel: t("settings.agent.prompts.reset") },
    );
    if (!ok) return;
    setSaving(true);
    try {
      const res = await commands.agentPromptReset(entry.id);
      if (res.status === "ok") {
        onSaved(res.data);
        setDraft(res.data.content);
        showToast(t("settings.agent.prompts.resetSuccess"));
      } else {
        showToast(
          typeof res.error === "string" ? res.error : t("settings.agent.prompts.resetFailed"),
        );
      }
    } catch (e) {
      showToast(String(e) || t("settings.agent.prompts.resetFailed"));
    } finally {
      setSaving(false);
    }
  }, [entry.id, onSaved, t]);

  return (
    <div className="skills-detail agent-prompt-detail">
      <div className="skills-detail-form">
        <div className="agent-prompt-detail-header">
          <div className="min-w-0">
            {compactHeader ? (
              <p className="setting-hint agent-prompt-path">{entry.path}</p>
            ) : (
              <>
                <h3 className="settings-subsection-title">{t(agentLabelKey(entry.id))}</h3>
                <p className="setting-hint settings-subsection-desc">
                  {t(agentDescKey(entry.id))}
                </p>
                <p className="setting-hint agent-prompt-path">{entry.path}</p>
              </>
            )}
          </div>
          <div className="settings-section-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => void handleReset()}
            >
              {t("settings.agent.prompts.reset")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={saving || !dirty}
              onClick={() => void handleSave()}
            >
              {saving ? t("settings.agent.prompts.saving") : t("settings.agent.prompts.save")}
            </Button>
          </div>
        </div>
        <div className="skills-field skills-field--body">
          <textarea
            className="settings-textarea skills-body-textarea agent-prompt-textarea"
            value={draft}
            spellCheck={false}
            aria-label={t(agentLabelKey(entry.id))}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

/** 单个智能体的提示词编辑（不再内嵌智能体列表）。 */
function AgentPromptPanel({ agentId }: { agentId: AgentId }) {
  const { t } = useI18n();
  const [entry, setEntry] = useState<AgentPromptEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await commands.agentPromptList();
      if (res.status === "ok") {
        const found = res.data.find((e) => e.id === agentId) ?? null;
        setEntry(found);
        if (!found) {
          setError(t("settings.agent.prompts.empty"));
        }
      } else {
        setError(
          typeof res.error === "string" ? res.error : t("settings.agent.prompts.loadFailed"),
        );
      }
    } catch (e) {
      setError(String(e) || t("settings.agent.prompts.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaved = useCallback((next: AgentPromptEntry) => {
    setEntry(next);
  }, []);

  if (loading) {
    return (
      <div className="settings-subsection">
        <p className="setting-hint">{t("settings.agent.prompts.loading")}</p>
      </div>
    );
  }

  if (error && !entry) {
    return (
      <div className="settings-subsection">
        <p className="setting-hint setting-hint--error">{error}</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
          {t("settings.agent.prompts.retry")}
        </Button>
      </div>
    );
  }

  if (!entry) {
    return <ModuleEmptyState title={t("settings.agent.prompts.empty")} />;
  }

  return (
    <div className="settings-subsection agent-prompt-solo">
      <PromptEditor key={entry.id} entry={entry} onSaved={handleSaved} compactHeader />
    </div>
  );
}

export function parseAgentSectionId(section: string): AgentId | null {
  if (!section.startsWith("agent:")) return null;
  const id = section.slice("agent:".length);
  return isAgentId(id) ? id : null;
}

export function agentSectionId(agentId: AgentId): `agent:${AgentId}` {
  return `agent:${agentId}`;
}

export function agentSettingsNavItems(
  t: (key: string) => string,
): { id: `agent:${AgentId}`; label: string }[] {
  return ALL_AGENT_IDS.map((id) => ({
    id: agentSectionId(id),
    label: t(getAgentDefinition(id).labelKey),
  }));
}

/**
 * 单个智能体配置：顶部 Tab + 内容区。
 * 内置工具按该 Agent 的 moduleFilter 隔离；Skills / Web / MCP 仍为全局面板。
 */
export function AgentConfigSection({ agentId }: { agentId: AgentId }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AgentConfigTab>("prompts");
  const def = getAgentDefinition(agentId);

  // 切换智能体时回到提示词
  useEffect(() => {
    setTab("prompts");
  }, [agentId]);

  let main: ReactNode;
  if (tab === "prompts") {
    main = <AgentPromptPanel agentId={agentId} />;
  } else if (tab === "harness") {
    main = <HarnessInventoryPanel />;
  } else if (tab === "skills") {
    main = <SkillsSection />;
  } else if (tab === "builtin") {
    main = <BuiltinToolsSettingsSection agentId={agentId} />;
  } else if (tab === "webSearch") {
    main = (
      <div className="settings-subsection">
        <WebSearchSettingsSection />
      </div>
    );
  } else {
    main = (
      <div className="settings-subsection">
        <p className="setting-hint settings-subsection-desc">
          {t("settings.mcpServices.description")}
        </p>
        <McpServicesSection contentOnly externalOnly />
      </div>
    );
  }

  return (
    <div className="settings-panel active agent-config-workspace">
      <header className="agent-config-header">
        <h2 className="agent-config-header__title">{t(def.labelKey)}</h2>
        <p className="agent-config-header__desc">{t(def.descriptionKey)}</p>
      </header>
      <div className="settings-tabs agent-config-tabs" role="tablist" aria-label={t(def.labelKey)}>
        {AGENT_CONFIG_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`settings-tab${tab === item.id ? " is-active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="agent-config-main">{main}</div>
    </div>
  );
}

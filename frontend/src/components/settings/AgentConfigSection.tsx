import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { commands, type AgentPromptEntry } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { isAgentId } from "../../lib/ai/agents";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { SkillsSection } from "./SkillsSection";

type AgentTab = "prompts" | "skills";

function agentLabelKey(id: string): string {
  return isAgentId(id) ? `ai.agents.${id}.label` : "settings.agent.prompts.unknown";
}

function agentDescKey(id: string): string {
  return isAgentId(id) ? `ai.agents.${id}.description` : "settings.agent.prompts.systemDesc";
}

function PromptEditor({
  entry,
  onSaved,
}: {
  entry: AgentPromptEntry;
  onSaved: (next: AgentPromptEntry) => void;
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
            <h3 className="settings-subsection-title">{t(agentLabelKey(entry.id))}</h3>
            <p className="setting-hint settings-subsection-desc">
              {t(agentDescKey(entry.id))}
            </p>
            <p className="setting-hint agent-prompt-path">{entry.path}</p>
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

function PromptsPanel() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AgentPromptEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await commands.agentPromptList();
      if (res.status === "ok") {
        setEntries(res.data);
        setSelectedId((prev) => {
          if (prev && res.data.some((e) => e.id === prev)) return prev;
          return res.data[0]?.id ?? null;
        });
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
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const handleSaved = useCallback((next: AgentPromptEntry) => {
    setEntries((prev) => prev.map((e) => (e.id === next.id ? next : e)));
  }, []);

  return (
    <div className="settings-subsection skills-section agent-prompts-section">
      {error ? (
        <div className="settings-subsection" style={{ marginBottom: 8 }}>
          <p className="setting-hint setting-hint--error">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            {t("settings.agent.prompts.retry")}
          </Button>
        </div>
      ) : null}

      <div className="skills-layout agent-prompts-layout">
        <aside
          className="skills-sidebar"
          aria-label={t("settings.agent.prompts.sidebarTitle")}
        >
          {loading ? (
            <p className="setting-hint skills-sidebar-hint">
              {t("settings.agent.prompts.loading")}
            </p>
          ) : entries.length === 0 ? (
            <p className="setting-hint skills-sidebar-hint">
              {t("settings.agent.prompts.empty")}
            </p>
          ) : (
            <ul className="skills-sidebar-list">
              {entries.map((entry) => {
                const active = entry.id === selectedId;
                return (
                  <li key={entry.id} className="skills-sidebar-row">
                    <button
                      type="button"
                      className={`skills-sidebar-item${active ? " is-active" : ""}`}
                      onClick={() => setSelectedId(entry.id)}
                    >
                      <span className="skills-sidebar-item__name">
                        {t(agentLabelKey(entry.id))}
                      </span>
                      {entry.id === "chat" ? (
                        <span className="agent-prompt-sidebar-tag">
                          {t("ai.agents.noTools")}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="skills-content">
          {!selected && !loading ? (
            <ModuleEmptyState title={t("settings.agent.prompts.selectHint")} />
          ) : null}
          {selected ? (
            <PromptEditor
              key={selected.id}
              entry={selected}
              onSaved={handleSaved}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AgentConfigSection() {
  const { t } = useI18n();
  const [tab, setTab] = useState<AgentTab>("prompts");

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.agent.title")}</h2>
          <p className="section-desc">{t("settings.agent.desc")}</p>
        </div>
      </div>

      <div className="settings-tabs" role="tablist">
        {(
          [
            ["prompts", t("settings.agent.tabPrompts")],
            ["skills", t("settings.agent.tabSkills")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`settings-tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "prompts" ? <PromptsPanel /> : null}
      {tab === "skills" ? <SkillsSection /> : null}
    </div>
  );
}

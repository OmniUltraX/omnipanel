import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { commands, type AgentPromptEntry } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/primitives/Button";
import { SkillsSection } from "./SkillsSection";

type AgentTab = "prompts" | "skills";

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
    <div className="settings-subsection agent-prompt-card">
      <div className="settings-section-header">
        <div>
          <h3 className="settings-subsection-title">{t("settings.agent.prompts.systemTitle")}</h3>
          <p className="setting-hint settings-subsection-desc">
            {t("settings.agent.prompts.systemDesc")}
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
      <textarea
        className="settings-textarea agent-prompt-textarea"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        rows={18}
      />
    </div>
  );
}

function PromptsPanel() {
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
        setEntry(res.data[0] ?? null);
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

  if (loading) {
    return <p className="setting-hint">{t("settings.agent.prompts.loading")}</p>;
  }
  if (error) {
    return (
      <div className="settings-subsection">
        <p className="setting-hint" style={{ color: "var(--danger)" }}>
          {error}
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
          {t("settings.agent.prompts.retry")}
        </Button>
      </div>
    );
  }
  if (!entry) {
    return <p className="setting-hint">{t("settings.agent.prompts.empty")}</p>;
  }

  return <PromptEditor entry={entry} onSaved={setEntry} />;
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

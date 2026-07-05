import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { useI18n } from "../../i18n";
import { commands, type SkillRecord } from "../../ipc/bindings";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { TextInput } from "../ui/form/TextInput";

function SettingToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`toggle ${value ? "on" : ""}`}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      style={{ cursor: "pointer" }}
    />
  );
}

export function SkillsSection() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<SkillRecord | null>(null);
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formBody, setFormBody] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await commands.skillList();
      if (res.status === "ok") {
        setSkills(res.data);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = () => {
    setFormId("");
    setFormName("");
    setFormDesc("");
    setFormBody("");
    setEditing(null);
    setShowCreate(false);
  };

  const openCreate = () => {
    resetForm();
    setFormBody("# Skill\n\n在此编写技能说明。\n");
    setShowCreate(true);
  };

  const openEdit = (skill: SkillRecord) => {
    setEditing(skill);
    setFormId(skill.id);
    setFormName(skill.name);
    setFormDesc(skill.description);
    setShowCreate(true);
    void (async () => {
      const res = await commands.skillGet(skill.id);
      if (res.status === "ok") {
        setFormBody(res.data.body);
      }
    })();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editing) {
        const res = await commands.skillUpdate({
          id: editing.id,
          name: formName.trim() || undefined,
          description: formDesc.trim() || undefined,
          body: formBody || undefined,
        });
        if (res.status !== "ok") {
          setError(res.error);
          return;
        }
      } else {
        const res = await commands.skillCreate({
          id: formId.trim(),
          name: formName.trim(),
          description: formDesc.trim(),
          body: formBody,
          enabled: true,
        });
        if (res.status !== "ok") {
          setError(res.error);
          return;
        }
      }
      resetForm();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    const picked = await openFileDialog({ directory: true, multiple: false });
    if (!picked || Array.isArray(picked)) return;
    const res = await commands.skillImport(picked);
    if (res.status !== "ok") {
      setError(res.error);
      return;
    }
    await refresh();
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    const res = await commands.skillSetEnabled(id, enabled);
    if (res.status === "ok") {
      setSkills((prev) => prev.map((s) => (s.id === id ? res.data : s)));
    }
  };

  const handleRemove = async (id: string) => {
    const res = await commands.skillRemove(id);
    if (res.status === "ok") {
      await refresh();
    }
  };

  return (
    <div className="settings-subsection">
      <div className="settings-section-header">
        <div>
          <p className="setting-hint settings-subsection-desc">{t("settings.skills.desc")}</p>
        </div>
        <div className="settings-section-actions">
          <Button variant="secondary" size="sm" onClick={() => void handleImport()}>
            {t("settings.skills.import")}
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate}>
            {t("settings.skills.create")}
          </Button>
        </div>
      </div>

      {error ? <p className="setting-hint setting-hint--error">{error}</p> : null}

      {showCreate ? (
        <div className="settings-form-card">
          <h3>{editing ? t("settings.skills.edit") : t("settings.skills.create")}</h3>
          {!editing ? (
            <div className="setting-row">
              <div className="setting-label">
                <h4>{t("settings.skills.id")}</h4>
              </div>
              <div className="setting-control setting-control--wide">
                <TextInput value={formId} onChange={setFormId} placeholder="my-skill" />
              </div>
            </div>
          ) : null}
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.skills.name")}</h4>
            </div>
            <div className="setting-control setting-control--wide">
              <TextInput value={formName} onChange={setFormName} />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.skills.description")}</h4>
            </div>
            <div className="setting-control setting-control--wide">
              <TextInput value={formDesc} onChange={setFormDesc} />
            </div>
          </div>
          <div className="setting-row setting-row--stack">
            <div className="setting-label">
              <h4>{t("settings.skills.body")}</h4>
            </div>
            <textarea
              className="settings-textarea"
              rows={12}
              value={formBody}
              onChange={(e) => setFormBody(e.target.value)}
            />
          </div>
          <div className="settings-form-actions">
            <Button variant="secondary" size="sm" onClick={resetForm}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="setting-hint">{t("settings.skills.loading")}</p>
      ) : skills.length === 0 ? (
        <ModuleEmptyState title={t("settings.skills.empty")} />
      ) : (
        <ul className="ai-models-list">
          {skills.map((skill) => (
            <li key={skill.id} className="ai-provider-card">
              <div className="ai-provider-header">
                <div>
                  <h3>{skill.name}</h3>
                  <p className="section-desc">{skill.description || skill.id}</p>
                </div>
                <SettingToggle
                  value={skill.enabled}
                  onChange={(v) => void handleToggle(skill.id, v)}
                />
              </div>
              <div className="ai-provider-actions">
                <Button variant="secondary" size="sm" onClick={() => openEdit(skill)}>
                  {t("common.edit")}
                </Button>
                <Button variant="danger" size="sm" onClick={() => void handleRemove(skill.id)}>
                  {t("common.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

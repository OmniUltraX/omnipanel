import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { useI18n } from "../../i18n";
import { commands, type SkillRecord } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { TextInput } from "../ui/form/TextInput";

const NEW_SKILL_TEMPLATE = `---
name: New Skill
description: 
enabled: true
---

# Skill

在此编写技能说明。
`;

export function SkillsSection() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillRecord | null>(null);
  const [formId, setFormId] = useState("");
  const [formBody, setFormBody] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fileRes = await commands.skillList();
      if (fileRes.status !== "ok") {
        setError(fileRes.error);
        return;
      }
      setSkills(fileRes.data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectSkill = useCallback((skill: SkillRecord) => {
    setIsCreating(false);
    setEditing(skill);
    setSelectedId(skill.id);
    setFormId(skill.id);
    void (async () => {
      const res = await commands.skillGet(skill.id);
      if (res.status === "ok") {
        setFormBody(res.data.body);
      }
    })();
  }, []);

  // 列表刷新后：保留选中项；否则自动选中第一项
  useEffect(() => {
    if (isCreating || loading) return;
    if (selectedId && skills.some((s) => s.id === selectedId)) {
      return;
    }
    if (skills[0]) {
      selectSkill(skills[0]);
    } else {
      setSelectedId(null);
      setEditing(null);
    }
  }, [skills, selectedId, isCreating, loading, selectSkill]);

  const openCreate = () => {
    setIsCreating(true);
    setEditing(null);
    setSelectedId(null);
    setFormId("");
    setFormBody(NEW_SKILL_TEMPLATE);
  };

  const cancelCreate = () => {
    setIsCreating(false);
    if (skills[0]) {
      selectSkill(skills[0]);
    } else {
      setEditing(null);
      setSelectedId(null);
      setFormId("");
      setFormBody("");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const res = await commands.skillUpdate({
          id: editing.id,
          body: formBody || undefined,
        });
        if (res.status !== "ok") {
          setError(res.error);
          return;
        }
        setEditing(res.data);
        setSelectedId(res.data.id);
        await refresh();
        const detail = await commands.skillGet(res.data.id);
        if (detail.status === "ok") {
          setFormBody(detail.data.body);
        }
      } else {
        const res = await commands.skillCreate({
          id: formId.trim(),
          body: formBody,
          enabled: true,
        });
        if (res.status !== "ok") {
          setError(res.error);
          return;
        }
        setIsCreating(false);
        await refresh();
        selectSkill(res.data);
      }
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
    setIsCreating(false);
    await refresh();
    selectSkill(res.data);
  };

  const handleRemove = async (id: string) => {
    const skill = skills.find((s) => s.id === id);
    const ok = await appConfirm(
      t("settings.skills.deleteConfirm", { name: skill?.name ?? id }),
      t("settings.skills.deleteTitle"),
      { confirmLabel: t("common.delete"), kind: "warning" },
    );
    if (!ok) return;

    const res = await commands.skillRemove(id);
    if (res.status !== "ok") {
      setError(res.error);
      return;
    }
    const remaining = skills.filter((s) => s.id !== id);
    setSkills(remaining);
    if (selectedId === id || isCreating) {
      if (remaining[0]) {
        selectSkill(remaining[0]);
      } else {
        setSelectedId(null);
        setEditing(null);
        setIsCreating(false);
        setFormId("");
        setFormBody("");
      }
    }
  };

  const showEditor = isCreating || !!editing;

  return (
    <div className="settings-subsection skills-section">
      {error ? <p className="setting-hint setting-hint--error">{error}</p> : null}

      <div className="skills-layout">
        <aside className="skills-sidebar" aria-label={t("settings.skills.sidebarTitle")}>
          <div className="skills-sidebar-toolbar">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={t("settings.skills.create")}
              aria-label={t("settings.skills.create")}
              onClick={openCreate}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={t("settings.skills.import")}
              aria-label={t("settings.skills.import")}
              onClick={() => void handleImport()}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M8 2v8m0 0L5.5 7.5M8 10l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 11.5V13a1 1 0 001 1h8a1 1 0 001-1v-1.5" strokeLinecap="round" />
              </svg>
            </Button>
          </div>

          {loading ? (
            <p className="setting-hint skills-sidebar-hint">{t("settings.skills.loading")}</p>
          ) : skills.length === 0 ? (
            <p className="setting-hint skills-sidebar-hint">{t("settings.skills.empty")}</p>
          ) : (
            <ul className="skills-sidebar-list">
              {skills.map((skill) => {
                const active = !isCreating && skill.id === selectedId;
                return (
                  <li key={skill.id} className="skills-sidebar-row">
                    <button
                      type="button"
                      className={`skills-sidebar-item${active ? " is-active" : ""}`}
                      onClick={() => selectSkill(skill)}
                    >
                      <span className="skills-sidebar-item__name">{skill.name}</span>
                    </button>
                    <button
                      type="button"
                      className="skills-sidebar-delete"
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(skill.id);
                      }}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                        <path
                          fill="currentColor"
                          d="M6 2h4l.5 1H13v1H3V3h2.5L6 2zm1 4v6H6V6h1zm2 0v6H8V6h1zm2 0v6h-1V6h1zM4.5 5h7l-.6 8.2A1.5 1.5 0 019.4 14.5H6.6a1.5 1.5 0 01-1.5-1.3L4.5 5z"
                        />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="skills-content">
          {!showEditor && !loading ? (
            <ModuleEmptyState
              title={
                skills.length === 0
                  ? t("settings.skills.empty")
                  : t("settings.skills.selectHint")
              }
            />
          ) : null}

          {showEditor ? (
            <div className="skills-detail">
              <div className="skills-detail-form">
                {isCreating ? (
                  <div className="skills-field">
                    <h4 className="skills-field__label">{t("settings.skills.id")}</h4>
                    <TextInput value={formId} onChange={setFormId} placeholder="my-skill" />
                  </div>
                ) : null}
                <div className="skills-field skills-field--body">
                  <textarea
                    className="settings-textarea skills-body-textarea"
                    value={formBody}
                    spellCheck={false}
                    aria-label={t("settings.skills.body")}
                    onChange={(e) => setFormBody(e.target.value)}
                  />
                </div>
                <div className="settings-form-actions">
                  {isCreating ? (
                    <Button variant="secondary" size="sm" onClick={cancelCreate}>
                      {t("common.cancel")}
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? t("common.saving") : t("common.save")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

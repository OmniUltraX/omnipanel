import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { useI18n } from "../../i18n";
import {
  commands,
  type SkillApplication,
  type SkillDbRecord,
  type SkillRecord,
  type SkillVersionChainEntry,
} from "../../ipc/bindings";
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

/** 相对时间格式化（简版，按毫秒时间戳计算）。 */
function formatRelativeTime(ts: number | null | undefined, locale: string): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return locale === "zh-CN" ? "刚刚" : "just now";
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000);
    return locale === "zh-CN" ? `${mins} 分钟前` : `${mins}m ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return locale === "zh-CN" ? `${hours} 小时前` : `${hours}h ago`;
  }
  const days = Math.floor(diff / 86_400_000);
  return locale === "zh-CN" ? `${days} 天前` : `${days}d ago`;
}

/** 计算成功率（百分比，0-100）。 */
function successRate(rec: SkillDbRecord | undefined): { rate: number; total: number } | null {
  if (!rec) return null;
  const total = rec.successCount + rec.failureCount;
  if (total === 0) return null;
  return { rate: Math.round((rec.successCount / total) * 100), total };
}

/** 合并文件层 + DB 层的 skill 视图模型。 */
interface SkillViewModel {
  record: SkillRecord;
  db?: SkillDbRecord;
}

export function SkillsSection() {
  const { t, locale } = useI18n();
  const [skills, setSkills] = useState<SkillViewModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<SkillRecord | null>(null);
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formBody, setFormBody] = useState("");
  const [saving, setSaving] = useState(false);

  // 展开历史面板的 skill id
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fileRes, dbRes] = await Promise.all([commands.skillList(), commands.skillListDb()]);
      if (fileRes.status !== "ok") {
        setError(fileRes.error);
        return;
      }
      const dbMap = new Map<string, SkillDbRecord>();
      if (dbRes.status === "ok") {
        for (const db of dbRes.data) {
          dbMap.set(db.id, db);
        }
      }
      const vms: SkillViewModel[] = fileRes.data.map((record) => ({
        record,
        db: dbMap.get(record.id),
      }));
      setSkills(vms);
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
      setSkills((prev) =>
        prev.map((s) => (s.record.id === id ? { ...s, record: res.data } : s)),
      );
    }
  };

  const handleRemove = async (id: string) => {
    const res = await commands.skillRemove(id);
    if (res.status === "ok") {
      await refresh();
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
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
          {skills.map((vm) => (
            <li key={vm.record.id} className="ai-provider-card skill-card">
              <div className="ai-provider-header">
                <div>
                  <h3>
                    {vm.record.name}
                    {vm.db && vm.db.version > 1 ? (
                      <span className="skill-version-badge">
                        {t("settings.skills.stats.version", { version: vm.db.version })}
                      </span>
                    ) : null}
                  </h3>
                  <p className="section-desc">{vm.record.description || vm.record.id}</p>
                  {/* DB 统计行 */}
                  {vm.db ? (
                    <div className="skill-stats-row">
                      {(() => {
                        const sr = successRate(vm.db);
                        return sr ? (
                          <span className="skill-stat-chip skill-stat-chip--success">
                            {t("settings.skills.stats.successRate", { rate: sr.rate })}
                          </span>
                        ) : (
                          <span className="skill-stat-chip skill-stat-chip--muted">
                            {t("settings.skills.stats.successRateEmpty")}
                          </span>
                        );
                      })()}
                      <span className="skill-stat-chip">
                        {t("settings.skills.stats.applied", {
                          count: (vm.db.successCount ?? 0) + (vm.db.failureCount ?? 0),
                        })}
                      </span>
                      {vm.db.lastAppliedAt ? (
                        <span className="skill-stat-chip">
                          {t("settings.skills.stats.lastApplied", {
                            time: formatRelativeTime(vm.db.lastAppliedAt, locale),
                          })}
                        </span>
                      ) : (
                        <span className="skill-stat-chip skill-stat-chip--muted">
                          {t("settings.skills.stats.lastAppliedNever")}
                        </span>
                      )}
                      {vm.db.parentVersionId ? (
                        <span
                          className="skill-stat-chip skill-stat-chip--parent"
                          title={vm.db.parentVersionId}
                        >
                          {t("settings.skills.stats.hasParent", {
                            parentId: vm.db.parentVersionId,
                          })}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <SettingToggle
                  value={vm.record.enabled}
                  onChange={(v) => void handleToggle(vm.record.id, v)}
                />
              </div>
              <div className="ai-provider-actions">
                <Button variant="secondary" size="sm" onClick={() => openEdit(vm.record)}>
                  {t("common.edit")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => toggleExpand(vm.record.id)}
                >
                  {expandedId === vm.record.id
                    ? t("settings.skills.history.collapse")
                    : t("settings.skills.history.expand")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void handleRemove(vm.record.id)}
                >
                  {t("common.delete")}
                </Button>
              </div>
              {expandedId === vm.record.id ? (
                <SkillHistoryPanel skillId={vm.record.id} onOutcomeUpdated={refresh} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Skill 详情面板：版本链 + 应用历史 + outcome 更新。 */
function SkillHistoryPanel({
  skillId,
  onOutcomeUpdated,
}: {
  skillId: string;
  onOutcomeUpdated: () => void;
}) {
  const { t, locale } = useI18n();
  const [chain, setChain] = useState<SkillVersionChainEntry[]>([]);
  const [apps, setApps] = useState<SkillApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // outcome 更新表单
  const [pendingAppId, setPendingAppId] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [chainRes, appsRes] = await Promise.all([
        commands.skillGetVersionChain(skillId),
        commands.skillListApplications(skillId, 20),
      ]);
      if (chainRes.status === "ok") setChain(chainRes.data);
      else setError(chainRes.error);
      if (appsRes.status === "ok") setApps(appsRes.data);
      else setError(appsRes.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUpdateOutcome = async (appId: string, outcome: string) => {
    const res = await commands.skillUpdateApplicationOutcome(
      appId,
      outcome,
      feedbackText.trim() || null,
    );
    if (res.status !== "ok") {
      setError(res.error);
      return;
    }
    setPendingAppId(null);
    setFeedbackText("");
    await refresh();
    onOutcomeUpdated();
  };

  const outcomeBadgeClass = (outcome: string): string => {
    switch (outcome) {
      case "success":
        return "skill-outcome-badge skill-outcome-badge--success";
      case "failure":
        return "skill-outcome-badge skill-outcome-badge--failure";
      case "partial":
        return "skill-outcome-badge skill-outcome-badge--partial";
      case "refined":
        return "skill-outcome-badge skill-outcome-badge--refined";
      default:
        return "skill-outcome-badge skill-outcome-badge--pending";
    }
  };

  const outcomeLabel = (outcome: string): string => {
    switch (outcome) {
      case "success":
        return t("settings.skills.history.outcomeSuccess");
      case "failure":
        return t("settings.skills.history.outcomeFailure");
      case "partial":
        return t("settings.skills.history.outcomePartial");
      case "refined":
        return t("settings.skills.history.outcomeRefined");
      default:
        return t("settings.skills.history.outcomePending");
    }
  };

  if (loading) {
    return <p className="setting-hint">{t("settings.skills.loading")}</p>;
  }

  return (
    <div className="skill-history-panel">
      {error ? <p className="setting-hint setting-hint--error">{error}</p> : null}

      {/* 版本链 */}
      <div className="skill-history-section">
        <h4 className="skill-history-section-title">
          {t("settings.skills.history.versionChain")}
        </h4>
        {chain.length === 0 ? (
          <p className="setting-hint">{t("settings.skills.history.empty")}</p>
        ) : (
          <ul className="skill-version-chain">
            {chain.map((entry) => (
              <li
                key={entry.id}
                className={`skill-version-chain-item ${
                  entry.id === skillId ? "skill-version-chain-item--current" : ""
                }`}
              >
                <span className="skill-version-id">{entry.id}</span>
                <span className="skill-version-label">
                  {t("settings.skills.history.versionLabel", { version: entry.version })}
                </span>
                <span className="skill-version-time">
                  {t("settings.skills.history.createdAt", {
                    time: formatRelativeTime(entry.createdAt, locale),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 应用历史 */}
      <div className="skill-history-section">
        <h4 className="skill-history-section-title">
          {t("settings.skills.history.applications")}
        </h4>
        {apps.length === 0 ? (
          <p className="setting-hint">{t("settings.skills.history.empty")}</p>
        ) : (
          <ul className="skill-applications-list">
            {apps.map((app) => (
              <li key={app.id} className="skill-application-item">
                <div className="skill-application-row">
                  <span className={outcomeBadgeClass(app.outcome)}>{outcomeLabel(app.outcome)}</span>
                  <span className="skill-application-time">
                    {formatRelativeTime(app.appliedAt, locale)}
                  </span>
                  {app.resourceType ? (
                    <span className="skill-application-resource">
                      {t("settings.skills.history.resource")}: {app.resourceType}
                      {app.resourceId ? ` / ${app.resourceId}` : ""}
                    </span>
                  ) : null}
                </div>
                {app.feedback ? (
                  <p className="skill-application-feedback">{app.feedback}</p>
                ) : null}
                {/* outcome 更新 UI */}
                {app.outcome === "pending" ? (
                  <div className="skill-application-actions">
                    {pendingAppId === app.id ? (
                      <>
                        <TextInput
                          value={feedbackText}
                          onChange={setFeedbackText}
                          placeholder={t("settings.skills.history.feedbackPlaceholder")}
                        />
                        <div className="skill-application-action-row">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleUpdateOutcome(app.id, "success")}
                          >
                            {outcomeLabel("success")}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleUpdateOutcome(app.id, "failure")}
                          >
                            {outcomeLabel("failure")}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleUpdateOutcome(app.id, "partial")}
                          >
                            {outcomeLabel("partial")}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setPendingAppId(null);
                              setFeedbackText("");
                            }}
                          >
                            {t("common.cancel")}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setPendingAppId(app.id);
                          setFeedbackText(app.feedback || "");
                        }}
                      >
                        {t("settings.skills.history.markAs")}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

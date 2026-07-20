import { useCallback, useEffect, useMemo, useState } from "react";
import { SubWindow } from "../../components/ui/SubWindow";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import {
  useResourceProfileNavStore,
  type ResourceKind,
} from "./resourceProfileNavStore";

import type { ResourceProfileSummary, ResourceSnapshotResult } from "../../ipc/bindings";

interface ObservationEntry {
  payload: Record<string, unknown>;
  observed_at: number;
  observer: string;
}

interface ProfileData {
  resource_type: string;
  resource_id: string;
  latest_observed_at: number;
  observations: Record<string, ObservationEntry>;
  found?: boolean;
}

interface ObservationDiff {
  has_previous: boolean;
  current_observed_at?: number;
  previous_observed_at?: number;
  added_keys?: string[];
  removed_keys?: string[];
  changed_keys?: Array<{ key: string; from: unknown; to: unknown }>;
  summary?: string;
}

const KIND_LABELS: Record<string, { zh: string; en: string }> = {
  hardware: { zh: "硬件信息", en: "Hardware" },
  services: { zh: "运行服务", en: "Services" },
  topology: { zh: "网络拓扑", en: "Topology" },
  key_paths: { zh: "关键路径", en: "Key Paths" },
  overview: { zh: "概览", en: "Overview" },
  schema_summary: { zh: "Schema 摘要", en: "Schema Summary" },
  table_relations: { zh: "表关系", en: "Table Relations" },
  index_health: { zh: "索引健康", en: "Index Health" },
  users: { zh: "用户", en: "Users" },
  note: { zh: "备注", en: "Note" },
};

const RESOURCE_TYPE_LABELS: Record<ResourceKind, { zh: string; en: string }> = {
  ssh: { zh: "SSH 主机", en: "SSH Host" },
  database: { zh: "数据库连接", en: "Database" },
  docker: { zh: "Docker", en: "Docker" },
  files: { zh: "文件", en: "Files" },
};

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return "-";
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function ResourceProfileSubWindow() {
  const { t, locale } = useI18n();
  const openTarget = useResourceProfileNavStore((s) => s.openTarget);
  const closeProfile = useResourceProfileNavStore((s) => s.closeProfile);

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [similar, setSimilar] = useState<ResourceProfileSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [collectResult, setCollectResult] = useState<ResourceSnapshotResult | null>(null);
  const [activeKind, setActiveKind] = useState<string | null>(null);
  // Phase 5 子任务 3：当前 activeKind 的快照 diff
  const [diff, setDiff] = useState<ObservationDiff | null>(null);

  const open = openTarget !== null;
  const resourceType = openTarget?.resourceType ?? "ssh";
  const resourceId = openTarget?.resourceId ?? "";
  const displayName = openTarget?.displayName ?? resourceId;

  const loadProfile = useCallback(async () => {
    if (!resourceId) return;
    setLoading(true);
    setError(null);
    try {
      const [profileRes, similarRes] = await Promise.all([
        commands.resourceGetProfile(resourceType, resourceId),
        commands.resourceFindSimilar(resourceType, resourceId, 5),
      ]);
      if (profileRes.status === "ok") {
        const data = profileRes.data as ProfileData | null;
        setProfile(data);
        // 自动选中第一个观测种类
        const kinds = data?.observations ? Object.keys(data.observations) : [];
        setActiveKind(kinds.length > 0 ? kinds[0] : null);
      } else {
        setError(profileRes.error?.message ?? "加载失败");
        setProfile(null);
      }
      if (similarRes.status === "ok") {
        setSimilar(similarRes.data ?? []);
      } else {
        setSimilar([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    if (!open) {
      setProfile(null);
      setSimilar([]);
      setError(null);
      setCollectResult(null);
      setActiveKind(null);
      setDiff(null);
      return;
    }
    void loadProfile();
  }, [open, loadProfile]);

  // Phase 5 子任务 3：当 activeKind 变化时拉取最近两次观测的 diff
  useEffect(() => {
    if (!open || !resourceId || !activeKind) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await commands.resourceComputeObservationDiff(
        resourceType,
        resourceId,
        activeKind,
      );
      if (cancelled) return;
      if (res.status === "ok") {
        setDiff(res.data as unknown as ObservationDiff);
      } else {
        setDiff(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, resourceType, resourceId, activeKind]);

  const handleCollect = useCallback(async () => {
    if (!resourceId) return;
    setCollecting(true);
    setCollectResult(null);
    try {
      const res =
        resourceType === "ssh"
          ? await commands.resourceCollectSshSnapshot(resourceId)
          : resourceType === "database"
            ? await commands.resourceCollectDatabaseSnapshot(resourceId)
            : null;
      if (res) {
        if (res.status === "ok") {
          setCollectResult(res.data);
          // 采集完成后重新加载档案
          await loadProfile();
        } else {
          setCollectResult({ savedKinds: [], errors: [res.error?.message ?? "采集失败"] });
        }
      }
    } catch (e) {
      setCollectResult({
        savedKinds: [],
        errors: [e instanceof Error ? e.message : String(e)],
      });
    } finally {
      setCollecting(false);
    }
  }, [resourceType, resourceId, loadProfile]);

  const handleDeleteAll = useCallback(async () => {
    if (!resourceId) return;
    if (!confirm(t("resource.profile.confirmDelete"))) return;
    try {
      const res = await commands.resourceDeleteObservations(resourceType, resourceId);
      if (res.status === "ok") {
        await loadProfile();
      } else {
        setError(res.error?.message ?? "删除失败");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [resourceType, resourceId, loadProfile, t]);

  const title = `${t("resource.profile.title")} · ${displayName}`;
  const typeLabel = RESOURCE_TYPE_LABELS[resourceType]?.[locale === "zh" ? "zh" : "en"] ?? resourceType;
  const canCollect = resourceType === "ssh" || resourceType === "database";

  const observationKinds = profile?.observations ? Object.keys(profile.observations) : [];
  const activeObservation =
    activeKind && profile?.observations ? profile.observations[activeKind] : null;

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={closeProfile}
      className="resource-profile-subwindow"
      widthRatio={0.72}
      heightRatio={0.82}
    >
      <div className="resource-profile-panel">
        {/* 头部：资源信息 + 操作 */}
        <header className="resource-profile-panel__header">
          <div className="resource-profile-panel__meta">
            <span className="resource-profile-panel__type-badge">{typeLabel}</span>
            <span className="resource-profile-panel__id">{resourceId}</span>
            {profile?.latest_observed_at ? (
              <span className="resource-profile-panel__time">
                {t("resource.profile.lastObserved")}: {formatTimestamp(profile.latest_observed_at)}
              </span>
            ) : null}
          </div>
          <div className="resource-profile-panel__actions">
            {canCollect ? (
              <Button
                variant="primary"
                size="sm"
                disabled={collecting}
                onClick={() => void handleCollect()}
              >
                {collecting ? t("resource.profile.collecting") : t("resource.profile.collect")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => void loadProfile()}>
              {t("common.refresh")}
            </Button>
            {observationKinds.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => void handleDeleteAll()}>
                {t("resource.profile.clearAll")}
              </Button>
            ) : null}
          </div>
        </header>

        {/* 采集结果反馈 */}
        {collectResult ? (
          <div className="resource-profile-panel__collect-result">
            {collectResult.savedKinds.length > 0 ? (
              <span className="resource-profile-panel__collect-ok">
                {t("resource.profile.collectedKinds")}: {collectResult.savedKinds.join(", ")}
              </span>
            ) : null}
            {collectResult.errors.length > 0 ? (
              <span className="resource-profile-panel__collect-err">
                {t("resource.profile.collectErrors")}: {collectResult.errors.join("; ")}
              </span>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="resource-profile-panel__error">{error}</div>
        ) : null}

        {/* 主体：左侧观测种类列表 + 右侧详情 */}
        <div className="resource-profile-panel__body">
          {loading ? (
            <div className="resource-profile-panel__empty">{t("common.loading")}</div>
          ) : !profile || observationKinds.length === 0 ? (
            <div className="resource-profile-panel__empty">
              {t("resource.profile.noObservations")}
              {canCollect ? (
                <p className="resource-profile-panel__hint">
                  {t("resource.profile.collectHint")}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <aside className="resource-profile-panel__sidebar">
                <h3 className="resource-profile-panel__sidebar-title">
                  {t("resource.profile.observations")}
                </h3>
                <ul className="resource-profile-panel__kind-list">
                  {observationKinds.map((kind) => {
                    const obs = profile.observations[kind];
                    const label = KIND_LABELS[kind]?.[locale === "zh" ? "zh" : "en"] ?? kind;
                    const isActive = kind === activeKind;
                    return (
                      <li key={kind}>
                        <button
                          type="button"
                          className={`resource-profile-panel__kind-item${isActive ? " is-active" : ""}`}
                          onClick={() => setActiveKind(kind)}
                        >
                          <span className="resource-profile-panel__kind-label">{label}</span>
                          <span className="resource-profile-panel__kind-time">
                            {formatTimestamp(obs?.observed_at)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </aside>

              <section className="resource-profile-panel__detail">
                {activeObservation ? (
                  <>
                    <div className="resource-profile-panel__detail-meta">
                      <span>
                        {t("resource.profile.observer")}: {activeObservation.observer}
                      </span>
                      <span>
                        {t("resource.profile.observedAt")}: {formatTimestamp(activeObservation.observed_at)}
                      </span>
                    </div>
                    {/* Phase 5 子任务 3：快照 diff 横幅 */}
                    {diff && diff.has_previous ? (
                      <div className="resource-profile-panel__diff-banner">
                        <div className="resource-profile-panel__diff-summary">
                          {t("resource.profile.diffSinceLast", {
                            time: formatTimestamp(diff.previous_observed_at),
                          })}
                        </div>
                        {diff.summary ? (
                          <div className="resource-profile-panel__diff-detail">
                            {diff.summary}
                          </div>
                        ) : null}
                        <div className="resource-profile-panel__diff-lists">
                          {(diff.added_keys ?? []).length > 0 ? (
                            <div className="resource-profile-panel__diff-section resource-profile-panel__diff-section--added">
                              <span className="resource-profile-panel__diff-label">+</span>
                              <span>{(diff.added_keys ?? []).join(", ")}</span>
                            </div>
                          ) : null}
                          {(diff.removed_keys ?? []).length > 0 ? (
                            <div className="resource-profile-panel__diff-section resource-profile-panel__diff-section--removed">
                              <span className="resource-profile-panel__diff-label">−</span>
                              <span>{(diff.removed_keys ?? []).join(", ")}</span>
                            </div>
                          ) : null}
                          {(diff.changed_keys ?? []).length > 0 ? (
                            <div className="resource-profile-panel__diff-section resource-profile-panel__diff-section--changed">
                              <span className="resource-profile-panel__diff-label">~</span>
                              <span>
                                {(diff.changed_keys ?? []).map((c) => c.key).join(", ")}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    <pre className="resource-profile-panel__payload">
                      {formatPayload(activeObservation.payload)}
                    </pre>
                  </>
                ) : (
                  <div className="resource-profile-panel__empty">
                    {t("resource.profile.selectKind")}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* 相似资源 */}
        {similar.length > 0 ? (
          <section className="resource-profile-panel__similar">
            <h3 className="resource-profile-panel__similar-title">
              {t("resource.profile.similarResources")}
            </h3>
            <ul className="resource-profile-panel__similar-list">
              {similar.map((s) => (
                <li key={`${s.resourceType}:${s.resourceId}`} className="resource-profile-panel__similar-item">
                  <span className="resource-profile-panel__similar-id">{s.resourceId}</span>
                  <span className="resource-profile-panel__similar-meta">
                    {t("resource.profile.kindsCount")}: {s.observationKinds ?? 0} ·{" "}
                    {t("resource.profile.knowledgeCount")}: {s.knowledgeCount ?? 0}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </SubWindow>
  );
}

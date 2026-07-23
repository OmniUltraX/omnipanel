import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/primitives/Button";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { commands, type AiSessionRecord, type AiTraceRecord } from "../../ipc/bindings";
import { runLoopOnce } from "../../lib/ai/loopRunner";
import { useLoopStore } from "../../stores/loopStore";
import { showToast } from "../../stores/toastStore";

function formatTs(ts: number | null | undefined): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return String(ts);
  }
}

/** Loop findings Triage：人只处理例外 */
export function LoopTriageTab() {
  const { t } = useI18n();
  const findings = useLoopStore((s) => s.listOpenFindings());
  const triageFinding = useLoopStore((s) => s.triageFinding);
  const ensureBuiltinSpecs = useLoopStore((s) => s.ensureBuiltinSpecs);

  useEffect(() => {
    ensureBuiltinSpecs();
  }, [ensureBuiltinSpecs]);

  if (findings.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.tabs.triage")}
        prompt={t("taskCenter.triage.empty")}
      />
    );
  }

  return (
    <div className="task-center-list">
      <section className="task-center-section">
        <h3 className="task-center-section__title">
          {t("taskCenter.triage.title")}
          <span className="task-center-section__count">{findings.length}</span>
        </h3>
        <div className="task-center-cards">
          {findings.map((f) => (
            <div key={f.id} className={`task-card task-card--draft risk-${f.severity}`}>
              <div className="task-card__header">
                <strong className="task-card__title">{f.title}</strong>
                <span className={`task-card__risk risk-${f.severity}`}>{f.severity}</span>
              </div>
              <div className="task-card__meta">
                <span className="setting-hint">
                  {f.resourceType ?? "—"}
                  {f.resourceId ? ` · ${f.resourceId.slice(0, 24)}` : ""}
                </span>
                <span className="setting-hint">{formatTs(f.createdAt)}</span>
              </div>
              <pre className="task-card__preview">{f.summary}</pre>
              {f.suggestedAction ? (
                <p className="setting-hint">{f.suggestedAction}</p>
              ) : null}
              {f.evidence ? (
                <pre className="task-card__preview" style={{ maxHeight: 120 }}>
                  {f.evidence.slice(0, 800)}
                </pre>
              ) : null}
              <div className="task-card__actions">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    triageFinding(f.id, "done");
                    showToast(t("taskCenter.triage.markedDone"));
                  }}
                >
                  {t("taskCenter.triage.done")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    triageFinding(f.id, "dismissed");
                    showToast(t("taskCenter.triage.dismissed"));
                  }}
                >
                  {t("taskCenter.triage.dismiss")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => triageFinding(f.id, "blocked")}
                >
                  {t("taskCenter.triage.block")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** 内置 Loop 列表与手动触发 */
export function LoopsTab() {
  const { t } = useI18n();
  const specs = useLoopStore((s) => Object.values(s.specs));
  const ensureBuiltinSpecs = useLoopStore((s) => s.ensureBuiltinSpecs);
  const setSpecEnabled = useLoopStore((s) => s.setSpecEnabled);
  const listRunsForLoop = useLoopStore((s) => s.listRunsForLoop);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    ensureBuiltinSpecs();
  }, [ensureBuiltinSpecs]);

  const run = useCallback(async (loopId: string) => {
    setBusyId(loopId);
    try {
      const result = await runLoopOnce({ loopId });
      showToast(
        result.verifyPassed
          ? t("taskCenter.loops.runOk")
          : t("taskCenter.loops.runStopped", { reason: result.error ?? "" }),
      );
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusyId(null);
    }
  }, [t]);

  if (specs.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.tabs.loops")}
        prompt={t("taskCenter.loops.empty")}
      />
    );
  }

  return (
    <div className="task-center-list">
      <section className="task-center-section">
        <h3 className="task-center-section__title">{t("taskCenter.loops.title")}</h3>
        <div className="task-center-cards">
          {specs.map((spec) => {
            const runs = listRunsForLoop(spec.id).slice(0, 3);
            return (
              <div key={spec.id} className="task-card">
                <div className="task-card__header">
                  <strong className="task-card__title">{spec.name}</strong>
                  <span className="setting-hint">{spec.enabled ? "on" : "off"}</span>
                </div>
                <p className="setting-hint">{spec.description}</p>
                <div className="task-card__meta">
                  <span className="setting-hint">
                    pilot={spec.pilotId ?? "—"} · verify={spec.verify.mode}
                  </span>
                </div>
                {runs.length > 0 ? (
                  <ul className="ai-task-card__children">
                    {runs.map((r) => (
                      <li key={r.id}>
                        <span>{formatTs(r.startedAt)}</span>
                        <span className="setting-hint">{r.status}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="task-card__actions">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyId === spec.id || !spec.enabled}
                    onClick={() => void run(spec.id)}
                  >
                    {busyId === spec.id
                      ? t("taskCenter.loops.running")
                      : t("taskCenter.loops.runOnce")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSpecEnabled(spec.id, !spec.enabled)}
                  >
                    {spec.enabled
                      ? t("taskCenter.loops.disable")
                      : t("taskCenter.loops.enable")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** AI Turn 时间线（ai_sessions + ai_traces） */
export function TurnTimelinePanel() {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<AiSessionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traces, setTraces] = useState<AiTraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await commands.aiListSessions(null);
      if (res.status === "ok") {
        setSessions(res.data);
        setError(null);
        if (!selectedId && res.data[0]) setSelectedId(res.data[0].id);
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const loadTraces = useCallback(async (sessionId: string) => {
    try {
      const res = await commands.aiListSessionTraces(sessionId);
      if (res.status === "ok") setTraces(res.data);
      else setTraces([]);
    } catch {
      setTraces([]);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (selectedId) void loadTraces(selectedId);
  }, [selectedId, loadTraces]);

  if (loading) {
    return (
      <div className="task-center-loading">
        <span>{t("taskCenter.history.loading")}</span>
      </div>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <div className="task-center-error">
        <span>{error}</span>
        <Button variant="ghost" size="sm" onClick={() => void loadSessions()}>
          {t("taskCenter.history.retry")}
        </Button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <WorkspaceEmptyPage
        title={t("taskCenter.history.timelineTab")}
        prompt={t("taskCenter.history.timelineEmpty")}
      />
    );
  }

  return (
    <div className="task-center-list">
      <div className="task-center-subtabs">
        <select
          className="task-center-session-select"
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value || null)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id.slice(0, 12)} · {s.backendId} · {formatTs(s.updatedAt)}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={() => void loadSessions()}>
          {t("taskCenter.history.refresh")}
        </Button>
      </div>
      <div className="task-center-table">
        <div className="task-center-table__head">
          <div className="task-center-table__cell task-center-table__cell--ts">
            {t("taskCenter.history.colTime")}
          </div>
          <div className="task-center-table__cell task-center-table__cell--action">
            Turn
          </div>
          <div className="task-center-table__cell task-center-table__cell--action">
            {t("taskCenter.history.colAction")}
          </div>
          <div className="task-center-table__cell task-center-table__cell--detail">
            {t("taskCenter.history.colDetail")}
          </div>
        </div>
        <div className="task-center-table__body">
          {traces.map((tr) => (
            <div key={tr.id} className="task-center-table__row">
              <div className="task-center-table__cell task-center-table__cell--ts">
                {formatTs(tr.ts)}
              </div>
              <div className="task-center-table__cell">{tr.turnIndex}</div>
              <div className="task-center-table__cell">
                <code>{tr.eventType}</code>
              </div>
              <div
                className="task-center-table__cell task-center-table__cell--detail"
                title={tr.payload}
              >
                {tr.payload.slice(0, 200)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

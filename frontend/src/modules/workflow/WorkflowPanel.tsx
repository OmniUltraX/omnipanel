import { useEffect, useState, type ReactNode } from "react";
import { useWorkflowStore } from "../../stores/workflowStore";
import { useActionStore } from "../../stores/actionStore";
import { useI18n } from "../../i18n";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import type {
  Workflow,
  WorkflowDetail,
  WorkflowType,
  WfRiskLevel,
  StepType,
  SaveWorkflowRequest,
  SaveStepRequest,
} from "../../ipc/bindings";

// ─── Sidebar section types ───────────────────────────────
type WfSection = "workflows" | "history";

const SECTION_IDS: WfSection[] = ["workflows", "history"];

const SECTION_ICONS: Record<WfSection, ReactNode> = {
  workflows: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  ),
};

// ─── Type filter tabs ────────────────────────────────────
type TypeFilter = "all" | WorkflowType;

const TYPE_FILTERS: TypeFilter[] = ["all", "script", "deploy", "patrol", "data_flow", "template"];

// ─── Risk badge helper ───────────────────────────────────
function riskBadgeClass(level: string): string {
  switch (level) {
    case "high":
    case "critical":
      return "badge badge-danger";
    case "medium":
      return "badge badge-warn";
    case "read_only":
      return "badge badge-success";
    default:
      return "badge badge-success";
  }
}

function typeBadgeClass(wfType: string): string {
  switch (wfType) {
    case "deploy":
      return "badge badge-danger";
    case "script":
      return "badge badge-accent";
    case "patrol":
      return "badge badge-success";
    case "data_flow":
      return "badge badge-warn";
    case "template":
      return "badge badge-accent";
    default:
      return "badge badge-muted";
  }
}

// ─── Format duration ─────────────────────────────────────
function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

// ─── Relative time ───────────────────────────────────────
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

// ─── Empty default for new step ──────────────────────────
function emptyStep(order: number): SaveStepRequest {
  return {
    id: null,
    name: "",
    description: "",
    step_type: "shell",
    command: "",
    step_order: order,
  };
}

// ═══════════════════════════════════════════════════════════
//  WorkflowPanel
// ═══════════════════════════════════════════════════════════
export function WorkflowPanel() {
  const { t } = useI18n();
  const enqueueAction = useActionStore((s) => s.enqueueAction);

  const {
    workflows,
    selectedDetail,
    executions,
    selectedWorkflowId,
    isLoading,
    error,
    loadWorkflows,
    selectWorkflow,
    saveWorkflow,
    deleteWorkflow,
    clearError,
  } = useWorkflowStore();

  const [activeSection, setActiveSection] = useState<WfSection>("workflows");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowDetail | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Load workflows on mount
  useEffect(() => {
    loadWorkflows();
  }, []);

  // Restore selected workflow from persisted state
  useEffect(() => {
    if (selectedWorkflowId && !selectedDetail) {
      selectWorkflow(selectedWorkflowId);
    }
  }, [selectedWorkflowId]);

  // ── Filter workflows ──────────────────────────────────
  const filteredWorkflows = workflows.filter((wf) => {
    if (typeFilter !== "all" && wf.workflow_type !== typeFilter) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return (
        wf.name.toLowerCase().includes(q) ||
        wf.description.toLowerCase().includes(q) ||
        wf.target.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ── Run workflow as action ────────────────────────────
  const runWorkflow = (wf: Workflow) => {
    enqueueAction({
      type: "workflow",
      title: wf.name,
      description: `${wf.target} · ${wf.description}`,
      command: `workflow run ${wf.id}`,
      resourceId: wf.target,
      source: "用户",
    });
  };

  // ── Delete handler ────────────────────────────────────
  const handleDelete = async () => {
    if (deleteConfirmId) {
      await deleteWorkflow(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  };

  // ── Type label i18n ───────────────────────────────────
  const typeLabel = (wt: WorkflowType) => {
    const key = `workflow.types.${wt === "data_flow" ? "workflow" : wt}`;
    return t(key);
  };

  // ── Risk label i18n ───────────────────────────────────
  const riskLabel = (rl: WfRiskLevel) => {
    const map: Record<WfRiskLevel, string> = {
      low: t("workflow.risk.low"),
      medium: t("workflow.risk.medium"),
      high: t("workflow.risk.high"),
      critical: t("workflow.risk.high"),
      read_only: t("workflow.risk.readonly"),
    };
    return map[rl] ?? rl;
  };

  const sidebar = (
    <div>
      <div className="wf-section-title">{t("workflow.ui.operations")}</div>
      {SECTION_IDS.map((sid) => (
        <button
          key={sid}
          type="button"
          className={`wf-nav-item${activeSection === sid ? " active" : ""}`}
          onClick={() => setActiveSection(sid)}
        >
          {SECTION_ICONS[sid]}
          {t(`workflow.ui.sections.${sid}`)}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <SidebarWorkspace sidebar={sidebar}>
        <div className="wf-content">
          {/* ── Error bar ──────────────────────────── */}
          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--sp-2) var(--sp-3)",
                marginBottom: "var(--sp-3)",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--r-sm)",
                fontSize: 12,
                color: "var(--danger)",
              }}
            >
              <span>{error}</span>
              <button
                onClick={clearError}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14 }}
              >
                ×
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════ */}
          {/*  WORKFLOWS LIST                            */}
          {/* ═══════════════════════════════════════════ */}
          {activeSection === "workflows" && (
            <div className="wf-panel active">
              {/* Header with search + create button */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "var(--sp-3)",
                  gap: "var(--sp-3)",
                }}
              >
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
                    {t("workflow.ui.workflowsTitle")}
                  </h2>
                  <p className="text-muted" style={{ fontSize: 12 }}>
                    {t("workflow.ui.workflowsDesc")}
                  </p>
                </div>
                <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                  <input
                    className="input input-search"
                    placeholder={t("workflow.ui.searchPlaceholder")}
                    style={{ width: 200 }}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      setEditingWorkflow(null);
                      setShowCreateDialog(true);
                    }}
                  >
                    + {t("workflow.ui.create")}
                  </button>
                </div>
              </div>

              {/* Type filter tabs */}
              <div
                style={{
                  display: "flex",
                  gap: "var(--sp-1)",
                  marginBottom: "var(--sp-3)",
                  flexWrap: "wrap",
                }}
              >
                {TYPE_FILTERS.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    className={`btn btn-sm${typeFilter === tf ? " btn-primary" : ""}`}
                    style={{ fontSize: 11 }}
                    onClick={() => setTypeFilter(tf)}
                  >
                    {tf === "all" ? t("workflow.ui.filterAll") : typeLabel(tf as WorkflowType)}
                  </button>
                ))}
              </div>

              {/* Loading indicator */}
              {isLoading && (
                <div style={{ textAlign: "center", padding: "var(--sp-6)", color: "var(--muted)" }}>
                  {t("workflow.ui.loading")}
                </div>
              )}

              {/* Workflow cards grid */}
              {!isLoading && (
                <div className="script-grid">
                  {filteredWorkflows.map((wf) => (
                    <div
                      key={wf.id}
                      className="script-card"
                      style={{
                        cursor: "pointer",
                        borderColor:
                          selectedWorkflowId === wf.id ? "var(--accent)" : undefined,
                      }}
                      onClick={() => selectWorkflow(wf.id)}
                    >
                      <div className="sc-header">
                        <div
                          className="sc-icon"
                          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                          </svg>
                        </div>
                        <div className="sc-name">{wf.name}</div>
                      </div>
                      <div className="sc-desc">{wf.description || "—"}</div>
                      <div className="sc-meta">
                        <span className={typeBadgeClass(wf.workflow_type)}>
                          {typeLabel(wf.workflow_type)}
                        </span>
                        <span className={riskBadgeClass(wf.risk_level)}>
                          {riskLabel(wf.risk_level)}
                        </span>
                        {wf.target && <span>{wf.target}</span>}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "var(--sp-1)",
                          marginTop: "var(--sp-2)",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          className="btn btn-sm btn-primary"
                          style={{ fontSize: 10 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            runWorkflow(wf);
                          }}
                        >
                          {t("workflow.ui.run")}
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 10 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingWorkflow(null);
                            selectWorkflow(wf.id);
                            // Open edit after load
                            setTimeout(async () => {
                              const store = useWorkflowStore.getState();
                              const detail = await store.getWorkflow(wf.id);
                              if (detail) {
                                setEditingWorkflow(detail);
                                setShowCreateDialog(true);
                              }
                            }, 0);
                          }}
                        >
                          {t("workflow.ui.edit")}
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 10, color: "var(--danger)" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmId(wf.id);
                          }}
                        >
                          {t("workflow.ui.delete")}
                        </button>
                      </div>
                    </div>
                  ))}

                  {!isLoading && filteredWorkflows.length === 0 && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        textAlign: "center",
                        padding: "var(--sp-6)",
                        color: "var(--muted)",
                        fontSize: 13,
                      }}
                    >
                      {query.trim()
                        ? t("workflow.ui.noResults")
                        : t("workflow.ui.noWorkflows")}
                    </div>
                  )}
                </div>
              )}

              {/* ── Selected workflow detail ──────────── */}
              {selectedDetail && !showCreateDialog && (
                <WorkflowDetailView
                  detail={selectedDetail}
                  executions={executions}
                  typeLabel={typeLabel}
                  riskLabel={riskLabel}
                  onRun={() => runWorkflow(selectedDetail.workflow)}
                  onEdit={() => {
                    setEditingWorkflow(selectedDetail);
                    setShowCreateDialog(true);
                  }}
                  onDelete={() => setDeleteConfirmId(selectedDetail.workflow.id)}
                />
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════════ */}
          {/*  EXECUTION HISTORY                         */}
          {/* ═══════════════════════════════════════════ */}
          {activeSection === "history" && (
            <ExecutionHistoryView
              workflows={workflows}
              executions={executions}
              selectedWorkflowId={selectedWorkflowId}
              loadExecutions={useWorkflowStore.getState().loadExecutions}
              typeLabel={typeLabel}
            />
          )}
        </div>
      </SidebarWorkspace>

      {/* ═══════════════════════════════════════════════ */}
      {/*  CREATE / EDIT DIALOG                         */}
      {/* ═══════════════════════════════════════════════ */}
      {showCreateDialog && (
        <WorkflowFormDialog
          existing={editingWorkflow}
          onClose={() => {
            setShowCreateDialog(false);
            setEditingWorkflow(null);
          }}
          onSave={async (req) => {
            const result = await saveWorkflow(req);
            if (result) {
              setShowCreateDialog(false);
              setEditingWorkflow(null);
            }
          }}
        />
      )}

      {/* ═══════════════════════════════════════════════ */}
      {/*  DELETE CONFIRMATION                          */}
      {/* ═══════════════════════════════════════════════ */}
      {deleteConfirmId && (
        <div className="knowledge-dialog" onClick={() => setDeleteConfirmId(null)}>
          <div
            className="knowledge-dialog-panel"
            style={{ width: 400, maxWidth: "90vw" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="knowledge-dialog-header">
              <h3>{t("workflow.ui.confirmDelete")}</h3>
              <button className="knowledge-dialog-close" onClick={() => setDeleteConfirmId(null)}>
                ✕
              </button>
            </div>
            <div className="knowledge-dialog-body">
              <p style={{ fontSize: 13 }}>
                {t("workflow.ui.confirmDeleteDesc")}
              </p>
            </div>
            <div className="knowledge-dialog-footer">
              <button className="knowledge-btn" onClick={() => setDeleteConfirmId(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="knowledge-btn"
                style={{ background: "var(--danger)", color: "#fff" }}
                onClick={handleDelete}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════
//  WorkflowDetailView
// ═══════════════════════════════════════════════════════════
function WorkflowDetailView({
  detail,
  executions,
  typeLabel,
  riskLabel,
  onRun,
  onEdit,
  onDelete,
}: {
  detail: WorkflowDetail;
  executions: import("../../ipc/bindings").WorkflowExecution[];
  typeLabel: (wt: WorkflowType) => string;
  riskLabel: (rl: WfRiskLevel) => string;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { workflow, steps } = detail;

  return (
    <div className="wf-flow" style={{ marginTop: "var(--sp-4)" }}>
      <div className="wf-flow-header">
        <h3>{workflow.name}</h3>
        <span className={typeBadgeClass(workflow.workflow_type)}>
          {typeLabel(workflow.workflow_type)}
        </span>
        <span className={riskBadgeClass(workflow.risk_level)}>
          {riskLabel(workflow.risk_level)}
        </span>
        {workflow.target && (
          <span className="text-muted text-sm">{workflow.target}</span>
        )}
        <span className="text-muted text-sm">
          {t("workflow.ui.envTag")}: {workflow.env_tag || "—"}
        </span>
        <button
          className="btn btn-primary btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={onRun}
        >
          {t("workflow.ui.run")}
        </button>
        <button className="btn btn-sm" onClick={onEdit}>
          {t("workflow.ui.edit")}
        </button>
        <button className="btn btn-sm" style={{ color: "var(--danger)" }} onClick={onDelete}>
          {t("workflow.ui.delete")}
        </button>
      </div>

      {workflow.description && (
        <p className="text-muted" style={{ fontSize: 12, marginBottom: "var(--sp-3)" }}>
          {workflow.description}
        </p>
      )}

      {/* Steps */}
      {steps.length > 0 && (
        <div style={{ marginBottom: "var(--sp-4)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: "var(--sp-2)" }}>
            {t("workflow.ui.steps")} ({steps.length})
          </div>
          {steps.map((step, index) => (
            <div key={step.id}>
              <div className="wf-step">
                <div className="wf-step-num">{index + 1}</div>
                <div className="wf-step-body">
                  <h4>
                    {step.name}
                    <span
                      className={typeBadgeClass(step.step_type)}
                      style={{ marginLeft: "var(--sp-2)" }}
                    >
                      {step.step_type}
                    </span>
                  </h4>
                  <p>{step.description || step.command || "—"}</p>
                </div>
                <div className="wf-step-actions">
                  <span className="badge badge-muted">{step.status}</span>
                </div>
              </div>
              {index < steps.length - 1 && <div className="wf-connector" />}
            </div>
          ))}
        </div>
      )}

      {/* Recent executions */}
      {executions.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: "var(--sp-2)" }}>
            {t("workflow.ui.recentExecutions")} ({executions.length})
          </div>
          <table>
            <thead>
              <tr>
                <th>{t("workflow.panels.history.columns.status")}</th>
                <th>{t("workflow.panels.history.columns.triggeredBy")}</th>
                <th>{t("workflow.panels.history.columns.duration")}</th>
                <th>{t("workflow.panels.history.columns.time")}</th>
              </tr>
            </thead>
            <tbody>
              {executions.slice(0, 10).map((exec) => (
                <tr key={exec.id}>
                  <td>
                    <span
                      className={`badge ${
                        exec.status === "completed"
                          ? "badge-success"
                          : exec.status === "failed"
                          ? "badge-danger"
                          : exec.status === "running"
                          ? "badge-accent"
                          : "badge-muted"
                      }`}
                    >
                      {exec.status}
                    </span>
                  </td>
                  <td>{exec.triggered_by}</td>
                  <td>{formatDuration(exec.duration_ms)}</td>
                  <td className="text-muted">{relativeTime(exec.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  ExecutionHistoryView
// ═══════════════════════════════════════════════════════════
function ExecutionHistoryView({
  workflows,
  executions,
  selectedWorkflowId,
  loadExecutions,
  typeLabel,
}: {
  workflows: Workflow[];
  executions: import("../../ipc/bindings").WorkflowExecution[];
  selectedWorkflowId: string | null;
  loadExecutions: (workflowId: string, limit?: number) => Promise<void>;
  typeLabel: (wt: WorkflowType) => string;
}) {
  const { t } = useI18n();
  const [historyWfId, setHistoryWfId] = useState<string | null>(selectedWorkflowId);

  useEffect(() => {
    if (historyWfId) {
      loadExecutions(historyWfId);
    }
  }, [historyWfId]);

  return (
    <div className="wf-panel active">
      <div style={{ marginBottom: "var(--sp-4)" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
          {t("workflow.panels.history.title")}
        </h2>
        <p className="text-muted" style={{ fontSize: 12 }}>
          {t("workflow.panels.history.desc")}
        </p>
      </div>

      {/* Workflow selector for history */}
      <div style={{ marginBottom: "var(--sp-3)" }}>
        <Select
          value={historyWfId ?? ""}
          onChange={(v) => setHistoryWfId(v || null)}
          searchable={workflows.length >= 8}
          style={{ minWidth: 240 }}
          options={[
            { value: "", label: t("workflow.ui.selectWorkflow") },
            ...workflows.map((wf) => ({
              value: wf.id,
              label: `${wf.name} — ${typeLabel(wf.workflow_type)}`,
            })),
          ]}
        />
      </div>

      {/* Executions table */}
      {executions.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("workflow.panels.history.columns.name")}</th>
              <th>{t("workflow.panels.history.columns.status")}</th>
              <th>{t("workflow.panels.history.columns.triggeredBy")}</th>
              <th>{t("workflow.panels.history.columns.duration")}</th>
              <th>{t("workflow.panels.history.columns.time")}</th>
            </tr>
          </thead>
          <tbody>
            {executions.map((exec) => {
              const wf = workflows.find((w) => w.id === exec.workflow_id);
              return (
                <tr key={exec.id}>
                  <td style={{ fontWeight: 500 }}>{wf?.name ?? exec.workflow_id}</td>
                  <td>
                    <span
                      className={`badge ${
                        exec.status === "completed"
                          ? "badge-success"
                          : exec.status === "failed"
                          ? "badge-danger"
                          : exec.status === "running"
                          ? "badge-accent"
                          : "badge-muted"
                      }`}
                    >
                      {exec.status}
                    </span>
                  </td>
                  <td>{exec.triggered_by}</td>
                  <td>{formatDuration(exec.duration_ms)}</td>
                  <td className="text-muted">{relativeTime(exec.started_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div
          style={{
            textAlign: "center",
            padding: "var(--sp-6)",
            color: "var(--muted)",
            fontSize: 13,
          }}
        >
          {historyWfId ? t("workflow.ui.noExecutions") : t("workflow.ui.selectWorkflow")}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  WorkflowFormDialog (Create / Edit)
// ═══════════════════════════════════════════════════════════
function WorkflowFormDialog({
  existing,
  onClose,
  onSave,
}: {
  existing: WorkflowDetail | null;
  onClose: () => void;
  onSave: (req: SaveWorkflowRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  const isEdit = !!existing;

  const [name, setName] = useState(existing?.workflow.name ?? "");
  const [description, setDescription] = useState(existing?.workflow.description ?? "");
  const [workflowType, setWorkflowType] = useState<WorkflowType>(
    existing?.workflow.workflow_type ?? "script"
  );
  const [riskLevel, setRiskLevel] = useState<WfRiskLevel>(
    existing?.workflow.risk_level ?? "low"
  );
  const [target, setTarget] = useState(existing?.workflow.target ?? "");
  const [envTag, setEnvTag] = useState(existing?.workflow.env_tag ?? "dev");
  const [steps, setSteps] = useState<SaveStepRequest[]>(
    existing?.steps.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      step_type: s.step_type,
      command: s.command,
      step_order: s.step_order,
    })) ?? [emptyStep(0)]
  );
  const [saving, setSaving] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const updateStep = (index: number, field: keyof SaveStepRequest, value: string | number) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s))
    );
  };

  const addStep = () => {
    setSteps((prev) => [...prev, emptyStep(prev.length)]);
  };

  const removeStep = (index: number) => {
    setSteps((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, step_order: i }))
    );
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= steps.length) return;
    setSteps((prev) => {
      const copy = [...prev];
      [copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
      return copy.map((s, i) => ({ ...s, step_order: i }));
    });
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const req: SaveWorkflowRequest = {
      id: existing?.workflow.id ?? null,
      name: name.trim(),
      description: description.trim(),
      workflow_type: workflowType,
      risk_level: riskLevel,
      target: target.trim(),
      env_tag: envTag.trim() || "dev",
      steps: steps
        .filter((s) => s.name.trim())
        .map((s, i) => ({ ...s, step_order: i })),
    };
    await onSave(req);
    setSaving(false);
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="knowledge-dialog" onClick={handleOverlayClick}>
      <div
        className="knowledge-dialog-panel"
        style={{ width: 800, maxWidth: "95vw", maxHeight: "90vh" }}
      >
        <div className="knowledge-dialog-header">
          <h3>
            {isEdit ? t("workflow.ui.editWorkflow") : t("workflow.ui.createWorkflow")}
          </h3>
          <button className="knowledge-dialog-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="knowledge-dialog-body">
          {/* Basic info */}
          <div className="knowledge-field">
            <label>{t("workflow.ui.form.name")} *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workflow.ui.form.namePlaceholder")}
              autoFocus
            />
          </div>

          <div className="knowledge-field">
            <label>{t("workflow.ui.form.description")}</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("workflow.ui.form.descriptionPlaceholder")}
            />
          </div>

          <div className="knowledge-field-row" style={{ display: "flex", gap: "var(--sp-3)" }}>
            <div className="knowledge-field" style={{ flex: 1 }}>
              <label>{t("workflow.ui.form.type")}</label>
              <Select
                value={workflowType}
                onChange={(v) => setWorkflowType(v as WorkflowType)}
                searchable={false}
                options={[
                  { value: "script", label: "Script" },
                  { value: "deploy", label: "Deploy" },
                  { value: "patrol", label: "Patrol" },
                  { value: "data_flow", label: "Data Flow" },
                  { value: "template", label: "Template" },
                ]}
              />
            </div>
            <div className="knowledge-field" style={{ flex: 1 }}>
              <label>{t("workflow.ui.form.risk")}</label>
              <Select
                value={riskLevel}
                onChange={(v) => setRiskLevel(v as WfRiskLevel)}
                searchable={false}
                options={[
                  { value: "read_only", label: t("workflow.risk.readonly") },
                  { value: "low", label: t("workflow.risk.low") },
                  { value: "medium", label: t("workflow.risk.medium") },
                  { value: "high", label: t("workflow.risk.high") },
                  { value: "critical", label: t("workflow.risk.high") },
                ]}
              />
            </div>
          </div>

          <div className="knowledge-field-row" style={{ display: "flex", gap: "var(--sp-3)" }}>
            <div className="knowledge-field" style={{ flex: 1 }}>
              <label>{t("workflow.ui.form.target")}</label>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={t("workflow.ui.form.targetPlaceholder")}
              />
            </div>
            <div className="knowledge-field" style={{ flex: 1 }}>
              <label>{t("workflow.ui.form.envTag")}</label>
              <Select
                value={envTag}
                onChange={setEnvTag}
                searchable={false}
                options={[
                  { value: "dev", label: "dev" },
                  { value: "staging", label: "staging" },
                  { value: "prod", label: "prod" },
                ]}
              />
            </div>
          </div>

          {/* Steps */}
          <div style={{ marginTop: "var(--sp-2)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "var(--sp-2)",
              }}
            >
              <label style={{ fontSize: 12, fontWeight: 600 }}>
                {t("workflow.ui.form.steps")} ({steps.length})
              </label>
              <button className="btn btn-sm" type="button" onClick={addStep}>
                + {t("workflow.ui.form.addStep")}
              </button>
            </div>

            {steps.map((step, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  gap: "var(--sp-2)",
                  marginBottom: "var(--sp-2)",
                  padding: "var(--sp-2)",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-sm)",
                  alignItems: "flex-start",
                }}
              >
                <div
                  className="wf-step-num"
                  style={{ marginTop: 4, width: 24, height: 24, fontSize: 10 }}
                >
                  {index + 1}
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
                  <input
                    value={step.name}
                    onChange={(e) => updateStep(index, "name", e.target.value)}
                    placeholder={t("workflow.ui.form.stepName")}
                    style={{ fontSize: 12 }}
                  />
                  <div style={{ display: "flex", gap: "var(--sp-1)" }}>
                    <Select
                      size="sm"
                      value={step.step_type}
                      onChange={(v) => updateStep(index, "step_type", v)}
                      style={{ width: 80 }}
                      searchable={false}
                      options={[
                        { value: "shell", label: "Shell" },
                        { value: "sql", label: "SQL" },
                        { value: "docker", label: "Docker" },
                        { value: "workflow", label: "Workflow" },
                      ]}
                    />
                    <input
                      value={step.command}
                      onChange={(e) => updateStep(index, "command", e.target.value)}
                      placeholder={t("workflow.ui.form.stepCommand")}
                      style={{ fontSize: 11, flex: 1 }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 2, flexDirection: "column" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: 10, padding: "2px 6px" }}
                    onClick={() => moveStep(index, -1)}
                    disabled={index === 0}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: 10, padding: "2px 6px" }}
                    onClick={() => moveStep(index, 1)}
                    disabled={index === steps.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: 10, padding: "2px 6px", color: "var(--danger)" }}
                    onClick={() => removeStep(index)}
                    disabled={steps.length <= 1}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="knowledge-dialog-footer">
          <button className="knowledge-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="knowledge-btn knowledge-btn-primary"
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
          >
            {saving ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

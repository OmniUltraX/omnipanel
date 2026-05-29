import { useMemo, useState, type ReactNode } from "react";
import { useActionStore } from "../../stores/actionStore";
import { useI18n } from "../../i18n";

type WorkflowSection = "scripts" | "templates" | "deploy" | "patrol" | "data" | "history";
type RiskTone = "success" | "warn" | "danger" | "accent";
type RiskKey = "high" | "medium" | "low" | "readonly";
type TypeKey = "shell" | "sql" | "docker" | "workflow";

const SECTION_IDS: WorkflowSection[] = ["scripts", "templates", "deploy", "patrol", "data", "history"];

const SECTION_ICONS: Record<WorkflowSection, ReactNode> = {
  scripts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  ),
  templates: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  ),
  deploy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  patrol: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  data: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  ),
};

const QUICK_SCRIPT_IDS = [
  "deployProd",
  "dbBackup",
  "dockerCleanup",
  "healthCheck",
  "logRotation",
  "sslRenew",
] as const;

const SCRIPT_META: Record<
  (typeof QUICK_SCRIPT_IDS)[number],
  {
    typeKey: TypeKey;
    riskKey: RiskKey;
    typeTone: RiskTone;
    riskTone: RiskTone;
    color: string;
    target: string;
    targetKey?: "allServers";
    command: string;
  }
> = {
  deployProd: {
    typeKey: "shell",
    riskKey: "high",
    typeTone: "accent",
    riskTone: "danger",
    color: "var(--success)",
    target: "prod-web-01, prod-web-02",
    command: "./deploy-prod.sh",
  },
  dbBackup: {
    typeKey: "sql",
    riskKey: "medium",
    typeTone: "warn",
    riskTone: "warn",
    color: "var(--accent)",
    target: "prod-db-master",
    command: "./backup-db.sh --verify",
  },
  dockerCleanup: {
    typeKey: "docker",
    riskKey: "low",
    typeTone: "accent",
    riskTone: "success",
    color: "var(--warn)",
    targetKey: "allServers",
    target: "",
    command: "docker system prune -af",
  },
  healthCheck: {
    typeKey: "shell",
    riskKey: "readonly",
    typeTone: "accent",
    riskTone: "success",
    color: "var(--danger)",
    targetKey: "allServers",
    target: "",
    command: "./server-health-check.sh --readonly",
  },
  logRotation: {
    typeKey: "shell",
    riskKey: "low",
    typeTone: "accent",
    riskTone: "success",
    color: "var(--accent)",
    target: "prod-web-01",
    command: "./logrotate-maint.sh",
  },
  sslRenew: {
    typeKey: "shell",
    riskKey: "medium",
    typeTone: "accent",
    riskTone: "warn",
    color: "var(--success)",
    target: "prod-web-01, prod-web-02",
    command: "./renew-cert.sh",
  },
};

const DEPLOY_FLOW_DEFS = [
  {
    id: "prodDeploy" as const,
    riskKey: "high" as RiskKey,
    riskTone: "danger" as RiskTone,
    steps: ["gitPull", "buildImage", "runTests", "composeUp", "healthCheck", "notify"] as const,
    stepStatus: ["passed", "passed", "passed", "passed", "passed", "passed"] as const,
  },
  {
    id: "stagingDeploy" as const,
    riskKey: "medium" as RiskKey,
    riskTone: "warn" as RiskTone,
    steps: ["gitPull", "buildPush", "deploy"] as const,
    stepStatus: ["ready", "ready", "ready"] as const,
  },
];

const HISTORY_ROWS = [
  { id: "prodDeploy", typeKey: "workflow" as TypeKey, target: "prod-web-01, prod-web-02", statusKey: "success" as const, duration: "3m 42s" },
  { id: "dbBackup", typeKey: "sql" as TypeKey, target: "prod-db-master", statusKey: "success" as const, duration: "1m 15s" },
  { id: "dockerCleanup", typeKey: "docker" as TypeKey, targetKey: "allServers" as const, target: "", statusKey: "success" as const, duration: "28s" },
  { id: "healthCheck", typeKey: "shell" as TypeKey, targetKey: "allServers" as const, target: "", statusKey: "warning" as const, duration: "45s" },
  { id: "stagingDeploy", typeKey: "workflow" as TypeKey, target: "staging-api", statusKey: "success" as const, duration: "2m 18s" },
];

const TEMPLATE_DEFS = [
  { id: "tailLogs" as const, typeKey: "shell" as TypeKey, riskKey: "readonly" as RiskKey },
  { id: "queryUser" as const, typeKey: "sql" as TypeKey, riskKey: "readonly" as RiskKey },
  { id: "restartContainer" as const, typeKey: "docker" as TypeKey, riskKey: "medium" as RiskKey },
];

const DATA_FLOW_DEFS = [
  { id: "investigation" as const, riskKey: "readonly" as RiskKey },
  { id: "repair" as const, riskKey: "high" as RiskKey },
  { id: "sync" as const, riskKey: "high" as RiskKey },
];

const PATROL_STEP_KEYS = ["cpuMemory", "disk", "service", "ssl", "security", "report"] as const;

function badgeClass(tone: RiskTone) {
  return `badge badge-${tone}`;
}

function riskBadgeClass(key: RiskKey) {
  if (key === "high") return "badge badge-danger";
  if (key === "medium") return "badge badge-warn";
  if (key === "low") return "badge badge-success";
  return "badge badge-success";
}

export function WorkflowPanel() {
  const { t } = useI18n();
  const enqueueAction = useActionStore((state) => state.enqueueAction);
  const [activeSection, setActiveSection] = useState<WorkflowSection>("scripts");
  const [query, setQuery] = useState("");

  const groupedSections = useMemo(() => {
    const groups = new Map<string, WorkflowSection[]>();
    for (const id of SECTION_IDS) {
      const group = t(`workflow.sections.${id}.group`);
      const list = groups.get(group) ?? [];
      list.push(id);
      groups.set(group, list);
    }
    return Array.from(groups.entries()).map(([title, items]) => ({ title, items }));
  }, [t]);

  const filteredScriptIds = QUICK_SCRIPT_IDS.filter((id) => {
    const name = t(`workflow.demo.scripts.${id}.name`);
    const desc = t(`workflow.demo.scripts.${id}.desc`);
    const meta = SCRIPT_META[id];
    const target = meta.targetKey ? t(`workflow.targets.${meta.targetKey}`) : meta.target;
    const q = query.toLowerCase();
    return [name, desc, target].some((field) => field.toLowerCase().includes(q));
  });

  const runAction = (title: string, description: string, command?: string) => {
    enqueueAction({
      type: "workflow",
      title,
      description,
      command,
      resourceId: "prod-web-01",
      source: "用户",
    });
  };

  const resolveTarget = (target: string, targetKey?: "allServers") =>
    targetKey ? t(`workflow.targets.${targetKey}`) : target;

  return (
    <div className="wf-workspace">
      <div className="wf-sidebar">
        {groupedSections.map((group) => (
          <div key={group.title}>
            <div className="wf-section-title">{group.title}</div>
            {group.items.map((sectionId) => (
              <button
                key={sectionId}
                type="button"
                className={`wf-nav-item${activeSection === sectionId ? " active" : ""}`}
                onClick={() => setActiveSection(sectionId)}
              >
                {SECTION_ICONS[sectionId]}
                {t(`workflow.sections.${sectionId}.label`)}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="wf-main">
        <div className="wf-content">
          {activeSection === "scripts" && (
            <div className="wf-panel active">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--sp-4)", gap: "var(--sp-3)" }}>
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("workflow.panels.scripts.title")}</h2>
                  <p className="text-muted" style={{ fontSize: 12 }}>{t("workflow.panels.scripts.desc")}</p>
                </div>
                <input
                  className="input input-search"
                  placeholder={t("workflow.panels.scripts.search")}
                  style={{ width: 220 }}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>

              <div className="script-grid">
                {filteredScriptIds.map((id) => {
                  const meta = SCRIPT_META[id];
                  const name = t(`workflow.demo.scripts.${id}.name`);
                  const desc = t(`workflow.demo.scripts.${id}.desc`);
                  const target = resolveTarget(meta.target, meta.targetKey);
                  return (
                    <button
                      key={id}
                      type="button"
                      className="script-card"
                      style={{ textAlign: "left" }}
                      onClick={() => runAction(name, `${target} · ${desc}`, meta.command)}
                    >
                      <div className="sc-header">
                        <div className="sc-icon" style={{ background: `${meta.color}20`, color: meta.color }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                          </svg>
                        </div>
                        <div className="sc-name">{name}</div>
                      </div>
                      <div className="sc-desc">{desc}</div>
                      <div className="sc-meta">
                        <span className={badgeClass(meta.typeTone)}>{t(`workflow.types.${meta.typeKey}`)}</span>
                        <span className={badgeClass(meta.riskTone)}>{t(`workflow.risk.${meta.riskKey}`)}</span>
                        <span>{target}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeSection === "deploy" && (
            <div className="wf-panel active">
              <div style={{ marginBottom: "var(--sp-4)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("workflow.panels.deploy.title")}</h2>
                <p className="text-muted" style={{ fontSize: 12 }}>{t("workflow.panels.deploy.desc")}</p>
              </div>
              {DEPLOY_FLOW_DEFS.map((flow) => {
                const name = t(`workflow.demo.flows.${flow.id}.name`);
                return (
                  <div key={flow.id} className="wf-flow">
                    <div className="wf-flow-header">
                      <h3>{name}</h3>
                      <span className={badgeClass(flow.riskTone)}>{t(`workflow.risk.${flow.riskKey}`)}</span>
                      <span className="text-muted text-sm">{t(`workflow.demo.flows.${flow.id}.meta`)}</span>
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ marginLeft: "auto" }}
                        onClick={() => runAction(name, `${name} · ${t("workflow.panels.deploy.runDesc")}`, `workflow run ${flow.id}`)}
                      >
                        {t("workflow.panels.deploy.run")}
                      </button>
                    </div>
                    {flow.steps.map((stepId, index) => {
                      const statusKey = flow.stepStatus[index];
                      const statusLabel = t(`workflow.status.${statusKey}`);
                      return (
                        <div key={stepId}>
                          <div className="wf-step">
                            <div className="wf-step-num">{index + 1}</div>
                            <div className="wf-step-body">
                              <h4>{t(`workflow.demo.flows.${flow.id}.steps.${stepId}.title`)}</h4>
                              <p>{t(`workflow.demo.flows.${flow.id}.steps.${stepId}.desc`)}</p>
                            </div>
                            <div className="wf-step-actions">
                              <span className={statusKey === "passed" ? "badge badge-success" : "badge badge-muted"}>{statusLabel}</span>
                            </div>
                          </div>
                          {index < flow.steps.length - 1 && <div className="wf-connector" />}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          {activeSection === "history" && (
            <div className="wf-panel active">
              <div style={{ marginBottom: "var(--sp-4)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("workflow.panels.history.title")}</h2>
                <p className="text-muted" style={{ fontSize: 12 }}>{t("workflow.panels.history.desc")}</p>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>{t("workflow.panels.history.columns.name")}</th>
                    <th>{t("workflow.panels.history.columns.type")}</th>
                    <th>{t("workflow.panels.history.columns.target")}</th>
                    <th>{t("workflow.panels.history.columns.status")}</th>
                    <th>{t("workflow.panels.history.columns.duration")}</th>
                    <th>{t("workflow.panels.history.columns.triggeredBy")}</th>
                    <th>{t("workflow.panels.history.columns.time")}</th>
                  </tr>
                </thead>
                <tbody>
                  {HISTORY_ROWS.map((row) => (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 500 }}>{t(`workflow.demo.history.${row.id}.name`)}</td>
                      <td><span className="badge badge-accent">{t(`workflow.types.${row.typeKey}`)}</span></td>
                      <td>{resolveTarget(row.target, row.targetKey)}</td>
                      <td>
                        <span className={`badge ${row.statusKey === "warning" ? "badge-warn" : "badge-success"}`}>
                          {t(`workflow.status.${row.statusKey}`)}
                        </span>
                      </td>
                      <td>{row.duration}</td>
                      <td>{t(`workflow.demo.history.${row.id}.triggeredBy`)}</td>
                      <td className="text-muted">{t(`workflow.demo.history.${row.id}.time`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeSection === "templates" && (
            <div className="wf-panel active">
              <div style={{ marginBottom: "var(--sp-4)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("workflow.panels.templates.title")}</h2>
                <p className="text-muted" style={{ fontSize: 12 }}>{t("workflow.panels.templates.desc")}</p>
              </div>
              <div className="script-grid">
                {TEMPLATE_DEFS.map(({ id, typeKey, riskKey }) => (
                  <div key={id} className="script-card">
                    <div className="sc-header">
                      <div className="sc-icon" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                          <path d="M14 2v6h6" />
                        </svg>
                      </div>
                      <div className="sc-name">{t(`workflow.demo.templates.${id}.name`)}</div>
                    </div>
                    <div className="sc-desc"><code>{t(`workflow.demo.templates.${id}.command`)}</code></div>
                    <div className="sc-meta">
                      <span className="badge badge-accent">{t(`workflow.types.${typeKey}`)}</span>
                      <span className={riskBadgeClass(riskKey)}>{t(`workflow.risk.${riskKey}`)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === "patrol" && (
            <div className="wf-panel active">
              <div style={{ marginBottom: "var(--sp-4)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("workflow.panels.patrol.title")}</h2>
                <p className="text-muted" style={{ fontSize: 12 }}>{t("workflow.panels.patrol.desc")}</p>
              </div>
              <div className="wf-flow">
                <div className="wf-flow-header">
                  <h3>{t("workflow.panels.patrol.dailyTitle")}</h3>
                  <span className="badge badge-success">{t("workflow.risk.readonly")}</span>
                  <span className="text-muted text-sm">{t("workflow.panels.patrol.schedule")}</span>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ marginLeft: "auto" }}
                    onClick={() =>
                      runAction(
                        t("workflow.panels.patrol.dailyTitle"),
                        `${t("workflow.panels.patrol.dailyTitle")} · ${t("workflow.panels.patrol.runDesc")}`,
                        "workflow run patrol --readonly",
                      )
                    }
                  >
                    {t("workflow.panels.patrol.runNow")}
                  </button>
                </div>
                {PATROL_STEP_KEYS.map((stepKey, index, list) => (
                  <div key={stepKey}>
                    <div className="wf-step">
                      <div className="wf-step-num">{index + 1}</div>
                      <div className="wf-step-body">
                        <h4>{t(`workflow.panels.patrol.steps.${stepKey}`)}</h4>
                        <p>{t("workflow.panels.patrol.stepDesc")}</p>
                      </div>
                    </div>
                    {index < list.length - 1 && <div className="wf-connector" />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === "data" && (
            <div className="wf-panel active">
              <div style={{ marginBottom: "var(--sp-4)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("workflow.panels.data.title")}</h2>
                <p className="text-muted" style={{ fontSize: 12 }}>{t("workflow.panels.data.desc")}</p>
              </div>
              <div className="script-grid">
                {DATA_FLOW_DEFS.map(({ id, riskKey }) => (
                  <div key={id} className="script-card">
                    <div className="sc-header">
                      <div className="sc-icon" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 3v18h18" />
                          <path d="m19 9-5 5-4-4-3 3" />
                        </svg>
                      </div>
                      <div className="sc-name">{t(`workflow.demo.dataFlows.${id}.name`)}</div>
                    </div>
                    <div className="sc-desc">{t(`workflow.demo.dataFlows.${id}.desc`)}</div>
                    <div className="sc-meta">
                      <span className="badge badge-warn">{t("workflow.types.sql")}</span>
                      <span className={riskBadgeClass(riskKey)}>{t(`workflow.risk.${riskKey}`)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useI18n } from "../../i18n";

const SNIPPET_ITEMS = [
  {
    id: "findLargeFiles" as const,
    tags: ["linux", "disk"],
    risk: "readonly" as const,
    used: 12,
    recent: "days2" as const,
    lines: [
      { comment: "comment1", cmd: "find /var -type f -size +100M -exec ls -lh {} \\; 2>/dev/null | sort -k5 -h" },
      { comment: "comment2", cmd: "find ~ -type f -size +1G -printf '%s %p\\n' | sort -rn | head -20" },
    ],
  },
  {
    id: "dockerStats" as const,
    tags: ["docker", "monitoring"],
    risk: "readonly" as const,
    used: 28,
    recent: "hour1" as const,
    lines: [
      {
        comment: "comment1",
        cmd: 'docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}\\t{{.BlockIO}}"',
      },
      {
        comment: "comment2",
        cmd: 'docker stats nginx-proxy --no-stream --format "CPU: {{.CPUPerc}} | MEM: {{.MemUsage}}"',
      },
    ],
  },
  {
    id: "pgSlowQuery" as const,
    tags: ["postgresql", "performance"],
    risk: "readonly" as const,
    used: 15,
    recent: "days3" as const,
    lines: [
      { comment: "comment1", cmd: "SELECT query, calls, mean_exec_time, total_exec_time, rows" },
      { comment: null, cmd: "FROM pg_stat_statements" },
      { comment: null, cmd: "ORDER BY mean_exec_time DESC LIMIT 20;" },
      { comment: "comment2", cmd: "SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state" },
      { comment: null, cmd: "FROM pg_stat_activity WHERE state != 'idle' ORDER BY duration DESC;" },
    ],
  },
  {
    id: "nginxReload" as const,
    tags: ["nginx", "deploy"],
    risk: "medium" as const,
    used: 8,
    recent: "week1" as const,
    lines: [
      { comment: "comment1", cmd: 'nginx -t && echo "Config OK" || echo "Config ERROR"' },
      { comment: "comment2", cmd: "nginx -s reload" },
      { comment: "comment3", cmd: "ls -la /etc/nginx/sites-enabled/" },
    ],
  },
] as const;

const CASE_ITEMS = [
  {
    id: "nginxCpu" as const,
    env: "production" as const,
    date: "2026-05-26",
    tags: ["nginx", "security", "rate-limit", "production"],
    sections: ["symptom", "rootCause", "resolution", "prevention"] as const,
  },
  {
    id: "diskFull" as const,
    env: "staging" as const,
    date: "2026-05-20",
    tags: ["postgresql", "disk", "docker"],
    sections: ["symptom", "rootCause", "resolution"] as const,
  },
] as const;

const AI_ITEMS = [
  {
    id: "nginxLogs" as const,
    generated: "hours2" as const,
    source: "terminalAi" as const,
    lines: ["line1", "line2", "line3", "line4"] as const,
  },
  {
    id: "dbSchema" as const,
    generated: "day1" as const,
    source: "database" as const,
    lines: ["line1", "line2", "line3", "line4", "line5", "line6"] as const,
  },
] as const;

const SIDEBAR_TAGS = ["nginx", "docker", "postgresql", "ssh", "security"] as const;

export function KnowledgePanel() {
  const { t } = useI18n();

  return (
    <div className="kb-workspace">
      <div className="kb-sidebar">
        <div className="kb-section-title">{t("knowledge.categories")}</div>
        <div className="kb-nav-item active" data-kb="snippets">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 17l6-6-6-6" />
            <path d="M12 19h8" />
          </svg>
          {t("knowledge.nav.snippets")}
        </div>
        <div className="kb-nav-item" data-kb="cases">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </svg>
          {t("knowledge.nav.cases")}
        </div>
        <div className="kb-nav-item" data-kb="ai">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
            <path d="M12 17v4M8 21h8" />
          </svg>
          {t("knowledge.nav.ai")}
        </div>
        <div className="kb-section-title" style={{ marginTop: "var(--sp-3)" }}>
          {t("knowledge.tags")}
        </div>
        {SIDEBAR_TAGS.map((tag) => (
          <div key={tag} className="kb-nav-item">
            <span className="tag" style={{ width: "100%", justifyContent: "center" }}>
              {tag}
            </span>
          </div>
        ))}
      </div>

      <div className="kb-main">
        <div className="kb-content">
          <div className="kb-panel active" id="panel-snippets">
            <div style={{ marginBottom: "var(--sp-4)" }}>
              <h2 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>
                {t("knowledge.snippets.title")}
              </h2>
              <p className="text-muted" style={{ fontSize: "12px" }}>
                {t("knowledge.snippets.desc")}
              </p>
            </div>

            {SNIPPET_ITEMS.map((item) => (
              <div key={item.id} className="snippet-card">
                <div className="snippet-header">
                  <h3>{t(`knowledge.demo.snippets.${item.id}.title`)}</h3>
                  {item.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="snippet-desc">{t(`knowledge.demo.snippets.${item.id}.desc`)}</div>
                <div className="snippet-code">
                  {item.lines.map((line, i) => (
                    <span key={i}>
                      {line.comment && (
                        <span className="comment">
                          {t(`knowledge.demo.snippets.${item.id}.${line.comment}`)}
                        </span>
                      )}
                      <span className="cmd">{line.cmd}</span>
                    </span>
                  ))}
                </div>
                <div className="snippet-meta">
                  <span className={`badge badge-${item.risk === "medium" ? "warn" : "success"}`}>
                    {t(`knowledge.risk.${item.risk}`)}
                  </span>
                  <span>{t("knowledge.meta.used", { count: item.used })}</span>
                  <span>{t("knowledge.meta.recent", { time: t(`knowledge.relativeTime.${item.recent}`) })}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="kb-panel" id="panel-cases">
            <div style={{ marginBottom: "var(--sp-4)" }}>
              <h2 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>
                {t("knowledge.cases.title")}
              </h2>
              <p className="text-muted" style={{ fontSize: "12px" }}>
                {t("knowledge.cases.desc")}
              </p>
            </div>

            {CASE_ITEMS.map((item) => (
              <div key={item.id} className="case-card">
                <div className="case-header">
                  <h3>{t(`knowledge.demo.cases.${item.id}.title`)}</h3>
                  <span className={`badge badge-${item.env === "production" ? "danger" : "warn"}`}>
                    {t(`knowledge.envBadge.${item.env}`)}
                  </span>
                  <span className="text-muted text-sm">{item.date}</span>
                </div>
                {item.sections.map((section) => (
                  <div key={section} className="case-section">
                    <h4>{t(`knowledge.caseSections.${section}`)}</h4>
                    <p>{t(`knowledge.demo.cases.${item.id}.${section}`)}</p>
                  </div>
                ))}
                <div className="case-tags">
                  {item.tags.map((tag) => (
                    <span key={tag} className="case-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="kb-panel" id="panel-ai">
            <div style={{ marginBottom: "var(--sp-4)" }}>
              <h2 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>
                {t("knowledge.ai.title")}
              </h2>
              <p className="text-muted" style={{ fontSize: "12px" }}>
                {t("knowledge.ai.desc")}
              </p>
            </div>

            {AI_ITEMS.map((item) => (
              <div key={item.id} className="snippet-card">
                <div className="snippet-header">
                  <h3>{t(`knowledge.demo.ai.${item.id}.title`)}</h3>
                  <span className="badge badge-accent">{t("knowledge.aiGenerated")}</span>
                </div>
                <div className="snippet-desc">{t(`knowledge.demo.ai.${item.id}.desc`)}</div>
                <div className="snippet-code">
                  <span className="comment">{t(`knowledge.demo.ai.${item.id}.summary`)}</span>
                  {item.lines.map((line) => (
                    <span key={line}>{t(`knowledge.demo.ai.${item.id}.${line}`)}</span>
                  ))}
                  <span className="comment">{t(`knowledge.demo.ai.${item.id}.recommendation`)}</span>
                </div>
                <div className="snippet-meta">
                  <span>{t("knowledge.aiMeta.generated", { time: t(`knowledge.relativeTime.${item.generated}`) })}</span>
                  <span>{t("knowledge.aiMeta.from", { source: t(`knowledge.aiSources.${item.source}`) })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

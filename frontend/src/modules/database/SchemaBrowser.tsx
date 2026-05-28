import { useI18n } from "../../i18n";

export function SchemaBrowser() {
  const { t } = useI18n();

  return (
    <div className="schema-panel">
      <div className="schema-header">
        <h3>{t("database.sidebar.title")}</h3>
        <button className="btn-icon" title={t("database.sidebar.refresh")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>
      <div className="schema-search">
        <input
          className="input input-search"
          placeholder={t("database.sidebar.search")}
          style={{ width: "100%", fontSize: "11px" }}
        />
      </div>
      <div className="schema-tree">
        <div className="schema-db">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
          </svg>
          app_production
        </div>

        <div className="schema-table active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          users
        </div>
        <div className="schema-col">
          <span className="col-key">PK</span> id <span className="col-type">uuid</span>
        </div>
        <div className="schema-col">
          email <span className="col-type">varchar</span>
        </div>
        <div className="schema-col">
          name <span className="col-type">varchar</span>
        </div>
        <div className="schema-col">
          role <span className="col-type">enum</span>
        </div>
        <div className="schema-col">
          created_at <span className="col-type">timestamptz</span>
        </div>

        <div className="schema-table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          orders
        </div>
        <div className="schema-col">
          <span className="col-key">PK</span> id <span className="col-type">uuid</span>
        </div>
        <div className="schema-col">
          <span className="col-key">FK</span> user_id <span className="col-type">uuid</span>
        </div>
        <div className="schema-col">
          total <span className="col-type">decimal</span>
        </div>
        <div className="schema-col">
          status <span className="col-type">enum</span>
        </div>
        <div className="schema-col">
          created_at <span className="col-type">timestamptz</span>
        </div>

        <div className="schema-table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          products
        </div>
        <div className="schema-table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          sessions
        </div>
        <div className="schema-table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          audit_logs
        </div>

        <div className="schema-db" style={{ marginTop: "var(--sp-3)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
          </svg>
          analytics
        </div>
        <div className="schema-table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          events
        </div>
        <div className="schema-table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
          page_views
        </div>
      </div>
    </div>
  );
}

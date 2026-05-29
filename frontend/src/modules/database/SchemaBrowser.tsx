import { useState, useMemo } from "react";
import { useI18n } from "../../i18n";

interface Column {
  name: string;
  type: string;
  isPk?: boolean;
  isFk?: boolean;
}

interface Table {
  name: string;
  columns: Column[];
}

interface Database {
  name: string;
  tables: Table[];
}

interface Connection {
  id: string;
  name: string;
  engine: string;
  databases: Database[];
}

const DEMO_CONNECTIONS: Connection[] = [
  {
    id: "prod-db-master",
    name: "prod-db-master",
    engine: "PostgreSQL 16",
    databases: [
      {
        name: "app_production",
        tables: [
          {
            name: "users",
            columns: [
              { name: "id", type: "uuid", isPk: true },
              { name: "email", type: "varchar" },
              { name: "name", type: "varchar" },
              { name: "role", type: "enum" },
              { name: "created_at", type: "timestamptz" },
            ],
          },
          {
            name: "orders",
            columns: [
              { name: "id", type: "uuid", isPk: true },
              { name: "user_id", type: "uuid", isFk: true },
              { name: "total", type: "decimal" },
              { name: "status", type: "enum" },
              { name: "created_at", type: "timestamptz" },
            ],
          },
          {
            name: "products",
            columns: [
              { name: "id", type: "uuid", isPk: true },
              { name: "name", type: "varchar" },
              { name: "price", type: "decimal" },
              { name: "category", type: "varchar" },
            ],
          },
          {
            name: "sessions",
            columns: [
              { name: "id", type: "uuid", isPk: true },
              { name: "user_id", type: "uuid", isFk: true },
              { name: "token", type: "varchar" },
              { name: "expires_at", type: "timestamptz" },
            ],
          },
          {
            name: "audit_logs",
            columns: [
              { name: "id", type: "bigint", isPk: true },
              { name: "user_id", type: "uuid", isFk: true },
              { name: "action", type: "varchar" },
              { name: "table_name", type: "varchar" },
              { name: "record_id", type: "uuid" },
              { name: "created_at", type: "timestamptz" },
            ],
          },
        ],
      },
      {
        name: "analytics",
        tables: [
          {
            name: "events",
            columns: [
              { name: "id", type: "bigint", isPk: true },
              { name: "event_type", type: "varchar" },
              { name: "payload", type: "jsonb" },
              { name: "created_at", type: "timestamptz" },
            ],
          },
          {
            name: "page_views",
            columns: [
              { name: "id", type: "bigint", isPk: true },
              { name: "url", type: "text" },
              { name: "user_id", type: "uuid" },
              { name: "duration_ms", type: "integer" },
              { name: "created_at", type: "timestamptz" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "staging-db",
    name: "staging-db",
    engine: "MySQL 8.0",
    databases: [
      {
        name: "staging_app",
        tables: [
          {
            name: "users",
            columns: [
              { name: "id", type: "int", isPk: true },
              { name: "email", type: "varchar" },
              { name: "password_hash", type: "varchar" },
              { name: "created_at", type: "datetime" },
            ],
          },
        ],
      },
    ],
  },
];

type TreeNodeType = "connection" | "database" | "table" | "column";

interface TreeNodeProps {
  id: string;
  label: string;
  type: TreeNodeType;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  meta?: string;
  isPk?: boolean;
  isFk?: boolean;
  hasChildren: boolean;
  active?: boolean;
}

function TreeNode({
  label,
  type,
  depth,
  expanded,
  onToggle,
  meta,
  isPk,
  isFk,
  hasChildren,
  active,
}: TreeNodeProps) {
  const indent = depth * 16 + 8;

  return (
    <div
      className={`tree-node tree-node--${type}${active ? " tree-node--active" : ""}`}
      style={{ paddingLeft: indent }}
      onClick={hasChildren ? onToggle : undefined}
    >
      <span className={`tree-arrow${hasChildren ? "" : " tree-leaf"}${expanded ? " tree-arrow--open" : ""}`}>
        {hasChildren ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : (
          <span className="tree-dot" />
        )}
      </span>
      <span className="tree-icon">
        {type === "connection" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <rect x="2" y="2" width="20" height="8" rx="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="18" r="1" fill="currentColor" />
          </svg>
        )}
        {type === "database" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
          </svg>
        )}
        {type === "table" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
        )}
        {type === "column" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <path d="M12 2v20" />
            <path d="M2 12h20" />
          </svg>
        )}
      </span>
      <span className="tree-label">{label}</span>
      {isPk && <span className="tree-badge tree-badge--pk">PK</span>}
      {isFk && <span className="tree-badge tree-badge--fk">FK</span>}
      {meta && <span className="tree-meta">{meta}</span>}
    </div>
  );
}

/** 后端真实连接（轻量结构：仅连接名 + 引擎 + 表名列表）。 */
export interface BackendConnection {
  id: string;
  name: string;
  engine: string;
  tables: string[];
}

interface SchemaBrowserProps {
  onCreateConnection?: () => void;
  /** 传入即进入后端数据模式（替代演示数据）；空数组表示后端无连接。 */
  connections?: BackendConnection[];
  activeConnId?: string | null;
  onSelectConnection?: (id: string) => void;
  onRefresh?: () => void;
}

export function SchemaBrowser({
  onCreateConnection,
  connections,
  activeConnId,
  onSelectConnection,
  onRefresh,
}: SchemaBrowserProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["conn:prod-db-master"]));
  const backendMode = connections !== undefined;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return DEMO_CONNECTIONS;
    const q = search.toLowerCase();
    return DEMO_CONNECTIONS.map((conn) => ({
      ...conn,
      databases: conn.databases
        .map((db) => ({
          ...db,
          tables: db.tables
            .filter(
              (tbl) =>
                tbl.name.toLowerCase().includes(q) ||
                tbl.columns.some((col) => col.name.toLowerCase().includes(q))
            )
            .map((tbl) => ({
              ...tbl,
              columns: tbl.columns.filter(
                (col) =>
                  tbl.name.toLowerCase().includes(q) ||
                  col.name.toLowerCase().includes(q)
              ),
            })),
        }))
        .filter((db) => db.tables.length > 0),
    })).filter((conn) => conn.databases.length > 0);
  }, [search]);

  return (
    <div className="schema-panel">
      <div className="schema-header">
        <h3>{t("database.sidebar.title")}</h3>
        <button
          className="btn-icon"
          title={t("database.sidebar.createConnection")}
          onClick={onCreateConnection}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button className="btn-icon" title={t("database.sidebar.refresh")} onClick={onRefresh}>
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
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "100%", fontSize: "11px" }}
        />
      </div>
      <div className="schema-tree">
        {backendMode ? (
          connections!.length === 0 ? (
            <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
              {t("database.sidebar.empty")}
            </div>
          ) : (
            connections!.map((conn) => {
              const connId = `conn:${conn.id}`;
              const connExpanded = expanded.has(connId) || conn.id === activeConnId;
              const q = search.trim().toLowerCase();
              const tables = q
                ? conn.tables.filter((tbl) => tbl.toLowerCase().includes(q))
                : conn.tables;
              return (
                <div key={conn.id}>
                  <TreeNode
                    id={connId}
                    label={conn.name}
                    type="connection"
                    depth={0}
                    expanded={connExpanded}
                    onToggle={() => {
                      onSelectConnection?.(conn.id);
                      toggle(connId);
                    }}
                    meta={conn.engine}
                    hasChildren={conn.tables.length > 0}
                    active={conn.id === activeConnId}
                  />
                  {connExpanded &&
                    tables.map((tbl) => (
                      <TreeNode
                        key={tbl}
                        id={`tbl:${conn.id}:${tbl}`}
                        label={tbl}
                        type="table"
                        depth={1}
                        expanded={false}
                        onToggle={() => {}}
                        hasChildren={false}
                      />
                    ))}
                </div>
              );
            })
          )
        ) : (
          filtered.map((conn) => {
          const connId = `conn:${conn.id}`;
          const connExpanded = expanded.has(connId);
          return (
            <div key={conn.id}>
              <TreeNode
                id={connId}
                label={conn.name}
                type="connection"
                depth={0}
                expanded={connExpanded}
                onToggle={() => toggle(connId)}
                meta={conn.engine}
                hasChildren={conn.databases.length > 0}
              />
              {connExpanded &&
                conn.databases.map((db) => {
                  const dbId = `db:${conn.id}:${db.name}`;
                  const dbExpanded = expanded.has(dbId);
                  return (
                    <div key={db.name}>
                      <TreeNode
                        id={dbId}
                        label={db.name}
                        type="database"
                        depth={1}
                        expanded={dbExpanded}
                        onToggle={() => toggle(dbId)}
                        meta={`${db.tables.length} tables`}
                        hasChildren={db.tables.length > 0}
                      />
                      {dbExpanded &&
                        db.tables.map((tbl) => {
                          const tblId = `tbl:${conn.id}:${db.name}:${tbl.name}`;
                          const tblExpanded = expanded.has(tblId);
                          return (
                            <div key={tbl.name}>
                              <TreeNode
                                id={tblId}
                                label={tbl.name}
                                type="table"
                                depth={2}
                                expanded={tblExpanded}
                                onToggle={() => toggle(tblId)}
                                meta={`${tbl.columns.length} cols`}
                                hasChildren={tbl.columns.length > 0}
                              />
                              {tblExpanded &&
                                tbl.columns.map((col) => (
                                  <TreeNode
                                    key={col.name}
                                    id={`col:${conn.id}:${db.name}:${tbl.name}:${col.name}`}
                                    label={col.name}
                                    type="column"
                                    depth={3}
                                    expanded={false}
                                    onToggle={() => {}}
                                    meta={col.type}
                                    isPk={col.isPk}
                                    isFk={col.isFk}
                                    hasChildren={false}
                                  />
                                ))}
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          );
          })
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import type { Connection } from "../../../ipc/bindings";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useDbConnectionListStore } from "../../../stores/dbConnectionListStore";
import { parsePanelConfig } from "../../server/panel/serverConnection";
import { canonicalPanelPluginId } from "../../server/panel/panelPlugin";
import type { SmallComponentDataSourceKind } from "./types";

function connectionSubtitle(conn: Connection): string {
  try {
    const cfg = conn.config
      ? (JSON.parse(conn.config) as Record<string, unknown>)
      : {};
    const host = typeof cfg.host === "string" ? cfg.host : undefined;
    const port = typeof cfg.port === "number" ? cfg.port : undefined;
    const user = typeof cfg.user === "string" ? cfg.user : undefined;
    const database = typeof cfg.database === "string" ? cfg.database : undefined;
    const address = typeof cfg.address === "string" ? cfg.address : undefined;
    if (host && user) return `${user}@${host}${port ? `:${port}` : ""}`;
    if (host) return `${host}${port ? `:${port}` : ""}`;
    if (address) return address;
    if (database) return database;
  } catch {
    // ignore
  }
  return conn.kind;
}

function dbConnectionSubtitle(conn: {
  host: string;
  port: number;
  user: string;
  database: string;
  db_type: string;
}): string {
  const host = conn.host.trim();
  const user = conn.user.trim();
  const database = conn.database.trim();
  if (host && user) {
    return `${user}@${host}:${conn.port}${database ? ` / ${database}` : ""}`;
  }
  if (database) return database;
  return conn.db_type;
}

export function useDataSourceOptions(
  kind: SmallComponentDataSourceKind,
  dbTypes?: readonly string[] | null,
  panelServiceTypes?: readonly ("bt" | "1panel")[] | null,
): SelectOption[] {
  const connections = useConnectionStore((s) => s.connections);
  const dbConnections = useDbConnectionListStore((s) => s.connections);
  const dbLoaded = useDbConnectionListStore((s) => s.loaded);
  const refreshDb = useDbConnectionListStore((s) => s.refresh);

  useEffect(() => {
    if (kind !== "database") return;
    if (dbLoaded) return;
    void refreshDb();
  }, [kind, dbLoaded, refreshDb]);

  return useMemo(() => {
    if (!kind) return [];
    if (kind === "database") {
      const allow = dbTypes?.map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];
      return dbConnections
        .filter((c) => {
          if (allow.length === 0) return true;
          return allow.includes(c.db_type.trim().toLowerCase());
        })
        .map((c) => ({
          value: c.id,
          label: c.name,
          subtitle: dbConnectionSubtitle(c),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    }
    const allowPanel =
      kind === "panel"
        ? (panelServiceTypes?.filter(Boolean) ?? [])
        : [];
    return connections
      .filter((c) => {
        if (c.kind !== kind) return false;
        if (kind !== "panel" || allowPanel.length === 0) return true;
        try {
          return allowPanel.some(
            (allowed) =>
              canonicalPanelPluginId(allowed) ===
              canonicalPanelPluginId(parsePanelConfig(c).serviceType),
          );
        } catch {
          return false;
        }
      })
      .map((c) => ({
        value: c.id,
        label: c.name,
        subtitle: connectionSubtitle(c),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  }, [connections, dbConnections, dbTypes, kind, panelServiceTypes]);
}

type Props = {
  kind: NonNullable<SmallComponentDataSourceKind>;
  value: string | null;
  onChange: (dataSourceId: string | null) => void;
  className?: string;
  disabled?: boolean;
  /** 默认 true（紧凑顶栏）；编辑表单传 false */
  borderless?: boolean;
  /** database 数据源按引擎过滤 */
  dbTypes?: readonly string[] | null;
  /** panel 数据源按面板类型过滤（如仅宝塔） */
  panelServiceTypes?: readonly ("bt" | "1panel")[] | null;
};

/** 小组件：按类型筛选连接作为数据源 */
export function SmallComponentDataSourceSelect({
  kind,
  value,
  onChange,
  className,
  disabled,
  borderless = true,
  dbTypes = null,
  panelServiceTypes = null,
}: Props) {
  const { t } = useI18n();
  const options = useDataSourceOptions(kind, dbTypes, panelServiceTypes);
  const dbConnections = useDbConnectionListStore((s) => s.connections);
  const refreshDb = useDbConnectionListStore((s) => s.refresh);
  const missingRefreshAttempted = useRef<string | null>(null);

  useEffect(() => {
    if (kind !== "database") return;
    if (!value) {
      missingRefreshAttempted.current = null;
      return;
    }
    if (dbConnections.some((c) => c.id === value)) {
      missingRefreshAttempted.current = null;
      return;
    }
    if (missingRefreshAttempted.current === value) return;
    missingRefreshAttempted.current = value;
    void refreshDb();
  }, [kind, value, dbConnections, refreshDb]);

  const placeholderKey =
    kind === "ssh"
      ? "homeWorkspace.customPanel.dataSource.placeholderSsh"
      : kind === "database"
        ? "homeWorkspace.customPanel.dataSource.placeholderDatabase"
        : kind === "docker"
          ? "homeWorkspace.customPanel.dataSource.placeholderDocker"
          : kind === "panel"
            ? "homeWorkspace.customPanel.dataSource.placeholderPanel"
            : "homeWorkspace.customPanel.dataSource.placeholder";

  return (
    <Select
      size="sm"
      borderless={borderless}
      searchable
      disabled={disabled}
      className={["home-custom-panel-widget__source", className]
        .filter(Boolean)
        .join(" ")}
      value={value ?? ""}
      onChange={(next) => onChange(next.trim() ? next : null)}
      placeholder={t(placeholderKey as never)}
      emptyText={t("homeWorkspace.customPanel.dataSource.empty")}
      aria-label={t("homeWorkspace.customPanel.dataSource.label")}
      options={options}
      panelMinWidth={220}
    />
  );
}

import { useMemo } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import type { Connection } from "../../../ipc/bindings";
import { useConnectionStore } from "../../../stores/connectionStore";
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
    if (host && user) return `${user}@${host}${port ? `:${port}` : ""}`;
    if (host) return `${host}${port ? `:${port}` : ""}`;
    if (database) return database;
  } catch {
    // ignore
  }
  return conn.kind;
}

export function useDataSourceOptions(
  kind: SmallComponentDataSourceKind,
): SelectOption[] {
  const connections = useConnectionStore((s) => s.connections);
  return useMemo(() => {
    if (!kind) return [];
    return connections
      .filter((c) => c.kind === kind)
      .map((c) => ({
        value: c.id,
        label: c.name,
        subtitle: connectionSubtitle(c),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  }, [connections, kind]);
}

type Props = {
  kind: NonNullable<SmallComponentDataSourceKind>;
  value: string | null;
  onChange: (dataSourceId: string | null) => void;
  className?: string;
  disabled?: boolean;
  /** 默认 true（紧凑顶栏）；编辑表单传 false */
  borderless?: boolean;
};

/** 小组件：按类型筛选连接作为数据源 */
export function SmallComponentDataSourceSelect({
  kind,
  value,
  onChange,
  className,
  disabled,
  borderless = true,
}: Props) {
  const { t } = useI18n();
  const options = useDataSourceOptions(kind);

  const placeholderKey =
    kind === "ssh"
      ? "homeWorkspace.customPanel.dataSource.placeholderSsh"
      : kind === "database"
        ? "homeWorkspace.customPanel.dataSource.placeholderDatabase"
        : kind === "docker"
          ? "homeWorkspace.customPanel.dataSource.placeholderDocker"
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

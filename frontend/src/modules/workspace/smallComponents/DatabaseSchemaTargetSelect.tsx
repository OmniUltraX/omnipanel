import { useEffect, useMemo, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import { useDbConnectionListStore } from "../../../stores/dbConnectionListStore";
import type { HomeCustomPanelWidgetTarget } from "./types";

export type DatabaseSchemaTargetSelectProps = {
  connectionId: string | null;
  value: HomeCustomPanelWidgetTarget | undefined;
  onChange: (target: HomeCustomPanelWidgetTarget | null) => void;
  className?: string;
  disabled?: boolean;
};

/** Database 二级目标：选择业务库（用于磁盘占用等按库统计）。 */
export function DatabaseSchemaTargetSelect({
  connectionId,
  value,
  onChange,
  className,
  disabled,
}: DatabaseSchemaTargetSelectProps) {
  const { t } = useI18n();
  const dbConnections = useDbConnectionListStore((s) => s.connections);
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connection = useMemo(
    () =>
      connectionId
        ? (dbConnections.find((c) => c.id === connectionId) ?? null)
        : null,
    [connectionId, dbConnections],
  );

  useEffect(() => {
    if (!connection) {
      setOptions([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const { listDatabases } = await import("../../database/api");
        const names = await listDatabases(connection, { quiet: true });
        if (cancelled) return;
        const defaultDb = connection.database.trim();
        const sorted = [...names]
          .map((name) => name.trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, "zh-CN"));
        if (defaultDb && !sorted.includes(defaultDb)) {
          sorted.unshift(defaultDb);
        }
        setOptions(
          sorted.map((name) => ({
            value: name,
            label: name,
            subtitle:
              defaultDb && name === defaultDb
                ? t("homeWorkspace.customPanel.target.defaultDatabase")
                : undefined,
          })),
        );
      } catch (err) {
        if (cancelled) return;
        setOptions([]);
        setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, t]);

  // 连接切换后：若尚未选库且连接有默认库，自动填入
  useEffect(() => {
    if (!connection) return;
    if (value?.kind === "database-schema" && value.database.trim()) return;
    const defaultDb = connection.database.trim();
    if (!defaultDb) return;
    onChange({ kind: "database-schema", database: defaultDb });
    // 仅在连接 id / 默认库变化时预填，避免把 onChange 放进依赖触发重复写入
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [connection?.id, connection?.database]);

  const selectedValue =
    value?.kind === "database-schema" ? value.database.trim() : "";

  return (
    <Select
      size="sm"
      searchable
      disabled={disabled || !connectionId}
      className={className}
      value={selectedValue}
      onChange={(next) => {
        const database = next.trim();
        if (!database) {
          onChange(null);
          return;
        }
        onChange({ kind: "database-schema", database });
      }}
      placeholder={
        !connectionId
          ? t("homeWorkspace.customPanel.target.needDatabaseConnection")
          : t("homeWorkspace.customPanel.target.placeholderDatabase")
      }
      emptyText={
        error ??
        (loading
          ? t("common.loading")
          : t("homeWorkspace.customPanel.target.emptyDatabase"))
      }
      aria-label={t("homeWorkspace.customPanel.target.database")}
      options={options}
      panelMinWidth={220}
    />
  );
}

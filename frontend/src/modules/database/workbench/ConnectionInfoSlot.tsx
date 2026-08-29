import { useEffect, useState } from "react";
import { ModuleEmptyState } from "../../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../../i18n";
import { usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import type { DbConnectionConfig } from "../api";
import { getEngineWorkbench, isEngineReady } from "../engineRegistry";
import { ensureEngineForDbType, type EnsureEngineResult } from "../ensureCatalogEngines";
import { DatabaseConnectionInfoPanel } from "../workspace/DatabaseConnectionInfoPanel";
import { RedisConnectionInfoPanel } from "../workspace/RedisConnectionInfoPanel";

function engineLabel(dbType: string): string {
  return dbType.trim() || "database";
}

export function ConnectionInfoSlot({
  connection,
  active,
}: {
  connection: DbConnectionConfig;
  active: boolean;
}) {
  const { t } = useI18n();
  const pluginItems = usePluginRuntimeStore((s) => s.items);
  const ready = isEngineReady(connection.db_type);
  const [ensure, setEnsure] = useState<EnsureEngineResult | { status: "installing" } | null>(null);

  useEffect(() => {
    if (ready) {
      setEnsure(null);
      return;
    }
    let cancelled = false;
    setEnsure({ status: "installing" });
    void ensureEngineForDbType(connection.db_type).then((result) => {
      if (!cancelled) setEnsure(result);
    });
    return () => {
      cancelled = true;
    };
  }, [connection.db_type, connection.id, pluginItems, ready]);

  if (!ready) {
    const name = engineLabel(connection.db_type);
    if (ensure?.status === "error") {
      return (
        <div className="module-empty-state-wrap">
          <ModuleEmptyState
            preset="inbox"
            title={t("plugins.engineEnsure.failedTitle")}
            desc={t("plugins.engineEnsure.failed", { name, error: ensure.message })}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setEnsure({ status: "installing" });
              void ensureEngineForDbType(connection.db_type).then(setEnsure);
            }}
          >
            {t("plugins.engineEnsure.retry")}
          </button>
        </div>
      );
    }
    if (ensure?.status === "unavailable") {
      return (
        <ModuleEmptyState
          preset="inbox"
          title={t("plugins.engineDisabled.title")}
          desc={t("plugins.engineEnsure.unavailable", { name })}
        />
      );
    }
    return (
      <ModuleEmptyState
        preset="inbox"
        title={t("plugins.engineEnsure.installingTitle")}
        desc={t("plugins.engineEnsure.installing", { name })}
      />
    );
  }

  const slot = getEngineWorkbench(connection.db_type).connectionInfo;
  if (slot === "redis") {
    return <RedisConnectionInfoPanel connection={connection} active={active} />;
  }
  if (slot === "none") {
    return (
      <ModuleEmptyState
        preset="inbox"
        title={t("plugins.engineDisabled.title")}
        desc={t("plugins.engineDisabled.hint")}
      />
    );
  }
  return <DatabaseConnectionInfoPanel connection={connection} active={active} />;
}

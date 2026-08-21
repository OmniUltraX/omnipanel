import { ModuleEmptyState } from "../../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import { getEngineWorkbench } from "../engineRegistry";
import { DatabaseConnectionInfoPanel } from "../workspace/DatabaseConnectionInfoPanel";
import { RedisConnectionInfoPanel } from "../workspace/RedisConnectionInfoPanel";

export function ConnectionInfoSlot({
  connection,
  active,
}: {
  connection: DbConnectionConfig;
  active: boolean;
}) {
  const { t } = useI18n();
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

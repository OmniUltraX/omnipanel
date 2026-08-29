type Translate = (key: string, params?: Record<string, string | number>) => string;
import { classifySql, inferDropTableDatabase } from "../../../lib/dangerousSql";
import {
  ACTION_DB_DROP_DATABASE,
  ACTION_DB_DROP_TABLE,
  dropDatabaseTarget,
  dropTableTarget,
} from "../../../lib/presenceTargets";
import { requireStepUp } from "../../../lib/stepUp";
import { showToast } from "../../../stores/toastStore";
import type { DbConnectionConfig } from "../api";

/** `undefined` 不需要 token；`null` 用户取消或拒绝。 */
export async function resolveSqlPresenceToken(
  connection: DbConnectionConfig,
  sql: string,
  t: Translate,
): Promise<string | null | undefined> {
  const danger = classifySql(sql);
  if (danger.kind === "none") return undefined;
  if (danger.kind === "multiple") {
    showToast(t("database.schemaTree.multipleDangerousSql"));
    return null;
  }
  if (danger.kind === "drop_table") {
    const database = connection.database || inferDropTableDatabase(sql) || "";
    const target = dropTableTarget(connection.id, database, [danger.name]);
    return requireStepUp({
      action: ACTION_DB_DROP_TABLE,
      target,
      title: t("database.schemaTree.confirmDeleteTitle"),
      message: t("database.schemaTree.confirmDeleteTable", {
        name: danger.name,
        database,
      }),
      reason: t("database.schemaTree.confirmDeleteTable", {
        name: danger.name,
        database,
      }),
    });
  }
  const target = dropDatabaseTarget(connection.id, danger.name);
  return requireStepUp({
    action: ACTION_DB_DROP_DATABASE,
    target,
    title: t("database.schemaTree.confirmDeleteTitle"),
    message: t("database.schemaTree.confirmDeleteDatabase", { name: danger.name }),
    reason: t("database.schemaTree.confirmDeleteDatabase", { name: danger.name }),
  });
}

type Translate = (key: string, params?: Record<string, string | number>) => string;
import { classifySql, inferDropTableDatabase } from "../../../lib/dangerousSql";
import {
  ACTION_DB_ALTER_DROP,
  ACTION_DB_DROP_DATABASE,
  ACTION_DB_DROP_TABLE,
  ACTION_DB_DROP_USER,
  ACTION_DB_FLUSH,
  ACTION_DB_KILL,
  ACTION_DB_TRUNCATE,
  dropDatabaseTarget,
  dropTableTarget,
  pipeTarget,
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
  if (danger.kind === "drop_database") {
    return requireStepUp({
      action: ACTION_DB_DROP_DATABASE,
      target: dropDatabaseTarget(connection.id, danger.name),
      title: t("database.schemaTree.confirmDeleteTitle"),
      message: t("database.schemaTree.confirmDeleteDatabase", { name: danger.name }),
      reason: t("database.schemaTree.confirmDeleteDatabase", { name: danger.name }),
    });
  }
  if (danger.kind === "drop_user") {
    return requireStepUp({
      action: ACTION_DB_DROP_USER,
      target: pipeTarget(connection.id, danger.name),
      title: t("database.schemaTree.confirmDeleteTitle"),
      message: t("database.schemaTree.confirmDeleteUser", { name: danger.name }),
      reason: t("database.schemaTree.confirmDeleteUser", { name: danger.name }),
    });
  }
  if (danger.kind === "alter_drop") {
    return requireStepUp({
      action: ACTION_DB_ALTER_DROP,
      target: pipeTarget(connection.id, connection.database, danger.name),
      title: t("database.schemaTree.confirmDeleteTitle"),
      message: t("database.schemaTree.confirmDeleteColumn", {
        name: danger.name,
        table: connection.database,
      }),
      reason: t("database.schemaTree.confirmDeleteColumn", {
        name: danger.name,
        table: connection.database,
      }),
    });
  }
  if (danger.kind === "truncate" || danger.kind === "delete_no_where") {
    return requireStepUp({
      action: ACTION_DB_TRUNCATE,
      target: dropTableTarget(connection.id, connection.database, [danger.name]),
      title: t("database.schemaTree.confirmDeleteTitle"),
      message: t("database.schemaTree.confirmTruncate", { name: danger.name }),
      reason: t("database.schemaTree.confirmTruncate", { name: danger.name }),
    });
  }
  if (danger.kind === "flush") {
    return requireStepUp({
      action: ACTION_DB_FLUSH,
      target: pipeTarget(connection.id, danger.name),
      title: danger.name,
      message: t("database.redisOps.flushConfirm", { command: danger.name }),
      reason: t("database.redisOps.flushConfirm", { command: danger.name }),
    });
  }
  return requireStepUp({
    action: ACTION_DB_KILL,
    target: pipeTarget(connection.id, danger.name),
    title: t("database.connectionInfo.killConfirmTitle"),
    message: t("database.connectionInfo.killConfirm", {
      id: danger.name,
      user: "",
      host: "",
    }),
    reason: t("database.connectionInfo.killConfirm", {
      id: danger.name,
      user: "",
      host: "",
    }),
  });
}

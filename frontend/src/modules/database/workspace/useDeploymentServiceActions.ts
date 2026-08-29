import { useCallback, useState } from "react";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { useI18n } from "../../../i18n";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { ACTION_DB_RESTART, restartTarget } from "../../../lib/presenceTargets";
import { requireStepUp } from "../../../lib/stepUp";
import { showToast } from "../../../stores/toastStore";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import {
  canManageDeployedService,
  createServiceLogTextIO,
  describeRestartTarget,
  type DatabaseServiceKind,
  restartGrantLocation,
  resolveMysqlServiceLogSource,
  resolveRedisServiceLogSource,
  toRemoteDeployment,
} from "./deploymentServiceActions";

export function useDeploymentServiceActions() {
  const { t } = useI18n();
  const [logOpen, setLogOpen] = useState(false);
  const [logIo, setLogIo] = useState<TextEditorIO | null>(null);
  const [logSubtitle, setLogSubtitle] = useState<string | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);

  const closeLog = useCallback(() => {
    setLogOpen(false);
    setLogIo(null);
    setLogSubtitle(null);
  }, []);

  const viewServiceLog = useCallback(
    async (
      connection: DbConnectionConfig,
      deployment: MysqlDeploymentInfo | RedisDeploymentInfo | null,
      service: DatabaseServiceKind,
    ) => {
      if (!canManageDeployedService(deployment) || logBusy) {
        return;
      }
      setLogBusy(true);
      try {
        const source =
          service === "mysql"
            ? await resolveMysqlServiceLogSource(connection, deployment)
            : await resolveRedisServiceLogSource(connection, deployment);
        setLogSubtitle(source.subtitle);
        setLogIo(createServiceLogTextIO(source, toRemoteDeployment(deployment)));
        setLogOpen(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const toastKey = message.includes("log_not_found")
          ? "database.connectionInfo.deployment.logNotFound"
          : "database.connectionInfo.deployment.logOpenFailed";
        showToast(t(toastKey));
      } finally {
        setLogBusy(false);
      }
    },
    [logBusy, t],
  );

  const restartService = useCallback(
    async (
      deployment: MysqlDeploymentInfo | RedisDeploymentInfo | null,
      service: DatabaseServiceKind,
      onAfterRestart?: () => void | Promise<void>,
    ) => {
      if (!canManageDeployedService(deployment) || restartBusy) {
        return;
      }
      const serviceLabel =
        service === "mysql"
          ? t("database.connectionInfo.deployment.serviceMysql")
          : t("database.connectionInfo.deployment.serviceRedis");
      const targetLabel = describeRestartTarget(deployment);
      const location = restartGrantLocation(deployment);
      const sshId = deployment.sshConnectionId;
      if (!sshId) {
        showToast(t("database.connectionInfo.deployment.restartFailed"));
        return;
      }
      const grantTarget = restartTarget(sshId, service, deployment.kind, location);
      const token = await requireStepUp({
        action: ACTION_DB_RESTART,
        target: grantTarget,
        title: t("database.connectionInfo.deployment.restartConfirmTitle"),
        message: t("database.connectionInfo.deployment.restartConfirmMessage", {
          service: serviceLabel,
          target: targetLabel,
        }),
        reason: t("database.connectionInfo.deployment.restartConfirmMessage", {
          service: serviceLabel,
          target: targetLabel,
        }),
        confirmLabel: t("database.connectionInfo.deployment.restartConfirmContinue"),
      });
      if (!token) {
        return;
      }

      setRestartBusy(true);
      try {
        await unwrapCommand(
          commands.dbRestartService(sshId, service, deployment.kind, location, token),
        );
        showToast(t("database.connectionInfo.deployment.restartSuccess"));
        await onAfterRestart?.();
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(
          detail
            ? `${t("database.connectionInfo.deployment.restartFailed")}: ${detail}`
            : t("database.connectionInfo.deployment.restartFailed"),
        );
      } finally {
        setRestartBusy(false);
      }
    },
    [restartBusy, t],
  );

  return {
    logOpen,
    logIo,
    logSubtitle,
    logBusy,
    restartBusy,
    closeLog,
    viewServiceLog,
    restartService,
    canManageDeployedService,
  };
}

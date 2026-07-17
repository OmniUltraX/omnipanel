import { useCallback, useState } from "react";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { appPrompt } from "../../../lib/appPrompt";
import { showToast } from "../../../stores/toastStore";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import {
  canManageDeployedService,
  createServiceLogTextIO,
  describeRestartTarget,
  type DatabaseServiceKind,
  restartDeployedService,
  resolveMysqlServiceLogSource,
  resolveRedisServiceLogSource,
  toRemoteDeployment,
} from "./deploymentServiceActions";

/** 二次确认后仍须在输入框原样输入该词，才真正执行重启 */
const RESTART_CONFIRM_TOKEN = "RESTART";

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
      const target = describeRestartTarget(deployment);

      const firstOk = await appConfirm(
        t("database.connectionInfo.deployment.restartConfirmMessage", {
          service: serviceLabel,
          target,
        }),
        t("database.connectionInfo.deployment.restartConfirmTitle"),
        {
          confirmLabel: t("database.connectionInfo.deployment.restartConfirmContinue"),
        },
      );
      if (!firstOk) {
        return;
      }

      const secondOk = await appConfirm(
        t("database.connectionInfo.deployment.restartConfirmMessage2", {
          service: serviceLabel,
          target,
        }),
        t("database.connectionInfo.deployment.restartConfirmTitle2"),
        {
          confirmLabel: t("database.connectionInfo.deployment.restartConfirmContinue2"),
        },
      );
      if (!secondOk) {
        return;
      }

      const typed = await appPrompt(
        t("database.connectionInfo.deployment.restartTypePrompt", {
          token: RESTART_CONFIRM_TOKEN,
          service: serviceLabel,
          target,
        }),
        "",
        t("database.connectionInfo.deployment.restartTypeTitle"),
      );
      if (typed == null) {
        return;
      }
      if (typed.trim() !== RESTART_CONFIRM_TOKEN) {
        showToast(t("database.connectionInfo.deployment.restartTypeMismatch"));
        return;
      }

      setRestartBusy(true);
      try {
        await restartDeployedService(service, deployment);
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

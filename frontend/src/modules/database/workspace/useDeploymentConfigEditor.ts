import { useCallback, useState } from "react";
import {
  createMysqlConfigTextIO,
  findMysqlConfigPath,
} from "../../../components/textEditor/io/mysqlConfigIO";
import {
  createRedisConfigTextIO,
  findRedisConfigPath,
} from "../../../components/textEditor/io/redisConfigIO";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { useI18n } from "../../../i18n";
import { showToast } from "../../../stores/toastStore";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import { redisConfigLog, redisConfigWarn, summarizeDeployment } from "../redisConfigDebug";

export function useDeploymentConfigEditor(connectionLabel: string) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [io, setIo] = useState<TextEditorIO | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    setIo(null);
    setConfigPath(null);
  }, []);

  const openMysqlConfig = useCallback(
    async (deployment: MysqlDeploymentInfo | null) => {
      if (!deployment || deployment.kind === "unknown" || opening) {
        return;
      }
      setOpening(true);
      try {
        const path = await findMysqlConfigPath(deployment);
        if (!path) {
          showToast(t("database.connectionInfo.deployment.configNotFound"));
          return;
        }
        setConfigPath(path);
        setIo(createMysqlConfigTextIO(path, deployment));
        setOpen(true);
      } catch (e) {
        showToast(
          typeof e === "string"
            ? e
            : e instanceof Error
              ? e.message
              : t("database.connectionInfo.deployment.configOpenFailed"),
        );
      } finally {
        setOpening(false);
      }
    },
    [opening, t],
  );

  const openRedisConfig = useCallback(
    async (connection: DbConnectionConfig, deployment: RedisDeploymentInfo | null) => {
      redisConfigLog("open.click", {
        connection: `${connection.name || connection.host}:${connection.port}`,
        deployment: deployment ? summarizeDeployment(deployment) : null,
      });
      if (!deployment || deployment.kind === "unknown" || opening) {
        redisConfigWarn("open.skip", {
          reason: !deployment
            ? "no-deployment"
            : deployment.kind === "unknown"
              ? "deployment-unknown"
              : "already-opening",
          deployment: deployment ? summarizeDeployment(deployment) : null,
        });
        return;
      }
      setOpening(true);
      try {
        const path = await findRedisConfigPath(connection, deployment);
        if (!path) {
          redisConfigWarn("open.not-found", {
            deployment: summarizeDeployment(deployment),
          });
          showToast(t("database.connectionInfo.deployment.configNotFound"));
          return;
        }
        redisConfigLog("open.success", { path });
        setConfigPath(path);
        setIo(createRedisConfigTextIO(path, deployment));
        setOpen(true);
      } catch (e) {
        redisConfigWarn("open.error", {
          error: e instanceof Error ? e.message : String(e),
          deployment: summarizeDeployment(deployment),
        });
        showToast(
          typeof e === "string"
            ? e
            : e instanceof Error
              ? e.message
              : t("database.connectionInfo.deployment.configOpenFailed"),
        );
      } finally {
        setOpening(false);
      }
    },
    [opening, t],
  );

  return {
    open,
    io,
    configPath,
    opening,
    connectionLabel,
    close,
    openMysqlConfig,
    openRedisConfig,
  };
}

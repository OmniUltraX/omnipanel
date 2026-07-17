import { Button } from "../../../components/ui/primitives/Button";
import { IconFile, IconRefresh, IconTerminal2 } from "../../../components/ui/Icons";
import { useI18n } from "../../../i18n";
import type { ReactNode } from "react";

interface DeploymentServiceActionButtonsProps {
  canManage: boolean;
  logBusy?: boolean;
  restartBusy?: boolean;
  configBusy?: boolean;
  onViewLog?: () => void;
  onRestart?: () => void;
  onOpenConfig?: () => void;
  configPath?: string;
  /** 前置额外操作按钮（如慢日志 / 二进制日志） */
  leading?: ReactNode;
}

export function DeploymentServiceActionButtons({
  canManage,
  logBusy = false,
  restartBusy = false,
  configBusy = false,
  onViewLog,
  onRestart,
  onOpenConfig,
  configPath,
  leading,
}: DeploymentServiceActionButtonsProps) {
  const { t } = useI18n();
  const logLabel = t("database.connectionInfo.deployment.viewLog");
  const restartLabel = t("database.connectionInfo.deployment.restartService");
  const configLabel = t("database.connectionInfo.deployment.configFile");
  const configTitle = configPath?.trim() ? `${configLabel}: ${configPath.trim()}` : configLabel;

  return (
    <div className="db-connection-info-deploy-actions">
      {leading}
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="db-connection-info-deploy-action-btn"
        title={logLabel}
        aria-label={logLabel}
        disabled={!canManage || logBusy || !onViewLog}
        onClick={onViewLog}
      >
        <IconTerminal2 size={14} />
      </Button>
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="db-connection-info-deploy-action-btn"
        title={restartLabel}
        aria-label={restartLabel}
        disabled={!canManage || restartBusy || !onRestart}
        onClick={onRestart}
      >
        <IconRefresh size={14} />
      </Button>
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="db-connection-info-deploy-action-btn"
        title={configTitle}
        aria-label={configTitle}
        disabled={configBusy || !onOpenConfig}
        onClick={onOpenConfig}
      >
        <IconFile size={14} />
      </Button>
    </div>
  );
}

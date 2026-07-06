import { Button } from "../../../components/ui/primitives/Button";
import { IconFile } from "../../../components/ui/Icons";
import { useI18n } from "../../../i18n";

interface DeploymentConfigOpenButtonProps {
  configPath?: string;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
}

export function DeploymentConfigOpenButton({
  configPath,
  onClick,
  busy,
  disabled,
}: DeploymentConfigOpenButtonProps) {
  const { t } = useI18n();
  const label = t("database.connectionInfo.deployment.configFile");
  const title = configPath?.trim()
    ? `${label}: ${configPath.trim()}`
    : label;

  return (
    <Button
      type="button"
      variant="icon"
      size="icon-xs"
      className="db-connection-info-deploy-config-btn"
      title={title}
      aria-label={title}
      disabled={disabled || busy || !onClick}
      onClick={onClick}
    >
      <IconFile size={14} />
    </Button>
  );
}

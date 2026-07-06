import { TextEditorSubWindow } from "../../../components/textEditor/TextEditorSubWindow";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { useI18n } from "../../../i18n";

interface DeploymentConfigEditorSubWindowProps {
  open: boolean;
  io: TextEditorIO | null;
  configPath: string | null;
  connectionLabel: string;
  onClose: () => void;
}

export function DeploymentConfigEditorSubWindow({
  open,
  io,
  configPath,
  connectionLabel,
  onClose,
}: DeploymentConfigEditorSubWindowProps) {
  const { t } = useI18n();
  return (
    <TextEditorSubWindow
      open={open}
      title={t("database.connectionInfo.deployment.configFile")}
      subtitle={configPath ? `${connectionLabel} · ${configPath}` : connectionLabel}
      io={io}
      language="ini"
      editable
      onClose={onClose}
    />
  );
}

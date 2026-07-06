import { TextEditorSubWindow } from "../../../components/textEditor/TextEditorSubWindow";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { useI18n } from "../../../i18n";

interface DeploymentServiceLogSubWindowProps {
  open: boolean;
  io: TextEditorIO | null;
  logSubtitle: string | null;
  connectionLabel: string;
  onClose: () => void;
}

export function DeploymentServiceLogSubWindow({
  open,
  io,
  logSubtitle,
  connectionLabel,
  onClose,
}: DeploymentServiceLogSubWindowProps) {
  const { t } = useI18n();
  return (
    <TextEditorSubWindow
      open={open}
      title={t("database.connectionInfo.deployment.viewLog")}
      subtitle={logSubtitle ? `${connectionLabel} · ${logSubtitle}` : connectionLabel}
      io={io}
      language="text"
      editable={false}
      onClose={onClose}
    />
  );
}

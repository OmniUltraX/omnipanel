import { useCallback, useEffect, useState } from "react";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { useI18n } from "../../../i18n";

export interface DockerImageRunCommandDialogProps {
  open: boolean;
  imageName: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (command: string) => void;
}

function defaultRunCommand(imageName: string): string {
  const safe = imageName.trim() || "IMAGE";
  const slug = safe
    .replace(/[/:]/g, "-")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `docker run -d --name ${slug || "app"} ${safe}`;
}

/** 编辑并确认 `docker run …` 命令。 */
export function DockerImageRunCommandDialog({
  open,
  imageName,
  busy = false,
  onClose,
  onConfirm,
}: DockerImageRunCommandDialogProps) {
  const { t } = useI18n();
  const [command, setCommand] = useState(() => defaultRunCommand(imageName));

  useEffect(() => {
    if (!open) return;
    setCommand(defaultRunCommand(imageName));
  }, [imageName, open]);

  const handleConfirm = useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed || busy) return;
    onConfirm(trimmed);
  }, [busy, command, onConfirm]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("docker.imagesPanel.runTitle")}
      subtitle={t("docker.imagesPanel.runHint")}
      size="md"
      clipboardAssist={false}
      closeDisabled={busy}
      cancelDisabled={busy}
      primaryAction={{
        label: busy ? t("docker.imagesPanel.running") : t("docker.imagesPanel.runConfirm"),
        disabled: busy || !command.trim(),
        onClick: handleConfirm,
      }}
    >
      <textarea
        className="docker-image-run-dialog__textarea"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        rows={6}
        spellCheck={false}
        disabled={busy}
        placeholder={t("docker.imagesPanel.runPlaceholder")}
      />
    </FormDialog>
  );
}

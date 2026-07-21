import { useEffect, useRef } from "react";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { useI18n } from "../../../i18n";

export interface DockerImageLogDialogProps {
  open: boolean;
  title: string;
  log: string;
  busy?: boolean;
  status?: { kind: "info" | "success" | "error"; message: string } | null;
  onClose: () => void;
}

/** 拉取 / 运行命令的日志弹窗。 */
export function DockerImageLogDialog({
  open,
  title,
  log,
  busy = false,
  status = null,
  onClose,
}: DockerImageLogDialogProps) {
  const { t } = useI18n();
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log, open]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      clipboardAssist={false}
      closeDisabled={busy}
      cancelDisabled={busy}
      cancelLabel={busy ? false : t("common.close")}
      status={status}
    >
      <pre ref={preRef} className="docker-image-log-dialog__pre">
        {log || (busy ? t("docker.imagesPanel.logWaiting") : t("docker.imagesPanel.logEmpty"))}
      </pre>
    </FormDialog>
  );
}

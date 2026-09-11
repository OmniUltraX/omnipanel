import { useState } from "react";
import type { ExternalVerdictDto } from "../../ipc/bindings";
import { Modal } from "../../components/ui/overlay/Modal";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import { useI18n } from "../../i18n";

type Props = {
  itemName: string;
  npm: string;
  verdict: ExternalVerdictDto;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ExternalConvertDialog({
  itemName,
  npm,
  verdict,
  confirming,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copyNpm = async () => {
    try {
      await navigator.clipboard.writeText(npm);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* WebView 无剪贴板权限时保持文本可选，手动复制 */
    }
  };
  return (
    <Modal open onClose={onCancel}>
      <div className="bg-bg-deeper border border-border rounded-lg shadow-2xl w-[520px] max-w-[92vw]">
        <WorkbenchPanelHeader label={t("plugins.external.title")} />
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-fg-2">
            <span className="font-mono">{itemName}</span>
            <span className="text-muted"> · v{verdict.version}</span>
          </p>
          <p className="text-xs text-muted">
            {t("plugins.external.npmPackage")}: <span className="font-mono">{npm}</span>
          </p>
          <p className="text-xs text-muted">
            {verdict.runnable ? t("plugins.external.runnableHint") : t("plugins.external.blockedHint")}
          </p>
          {verdict.features.length > 0 ? (
            <div>
              <p className="text-xs text-muted">{t("plugins.external.features")}</p>
              <ul className="space-y-1 mt-1">
                {verdict.features.map((feature) => (
                  <li key={feature.code} className="text-xs text-fg-2">
                    <span className="font-mono">{feature.code}</span>
                    {feature.explain ? <span className="text-muted"> · {feature.explain}</span> : null}
                    {feature.cmds.length > 0 ? (
                      <span className="text-muted">
                        {" "}
                        · {feature.cmds.map((cmd) => cmd.label).join(" / ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {verdict.reasons.length > 0 ? (
            <div>
              <p className="text-xs text-muted">{t("plugins.external.reasons")}</p>
              <ul className="space-y-1 mt-1">
                {verdict.reasons.map((reason) => (
                  <li key={reason} className="text-xs text-danger">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!verdict.runnable ? (
            <>
              <p className="text-xs text-muted">
                {t("plugins.external.openExternalHint", { npm })}
              </p>
              <WorkbenchActionButton onClick={() => void copyNpm()}>
                {copied ? t("plugins.external.copied") : t("plugins.external.copyNpm")}
              </WorkbenchActionButton>
            </>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <WorkbenchActionButton onClick={onCancel} disabled={confirming}>
            {t("common.cancel")}
          </WorkbenchActionButton>
          {verdict.runnable ? (
            <WorkbenchActionButton onClick={onConfirm} disabled={confirming}>
              {confirming ? t("plugins.catalog.installing") : t("plugins.center.convertInstall")}
            </WorkbenchActionButton>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

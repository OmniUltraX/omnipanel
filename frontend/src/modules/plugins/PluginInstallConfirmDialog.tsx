import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { Modal } from "../../components/ui/overlay/Modal";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import { useI18n } from "../../i18n";

type Props = {
  manifest: PluginManifest;
  fileName: string;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** 安装前权限确认：展示 permissions[] + methods[]，确认后才调安装。 */
export function PluginInstallConfirmDialog({
  manifest,
  fileName,
  confirming,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const methods = manifest.methods ?? [];
  return (
    <Modal open onClose={onCancel}>
      <div className="bg-bg-deeper border border-border rounded-lg shadow-2xl w-[520px] max-w-[92vw]">
        <WorkbenchPanelHeader
          label={t("plugins.install.confirmTitle")}
          tags={[{ text: `${manifest.id} v${manifest.version}`, emphasis: true }, { text: fileName }]}
        />
        <div className="px-4 py-3 space-y-3">
          <div>
            <div className="text-xs text-meta mb-1">{t("plugins.center.permissions")}</div>
            {manifest.permissions.length === 0 ? (
              <p className="text-xs text-muted">{t("plugins.install.noPermissions")}</p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {manifest.permissions.map((p) => (
                  <li key={p} className="plugin-center-badge plugin-center-badge--installed">
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {methods.length > 0 ? (
            <div>
              <div className="text-xs text-meta mb-1">{t("plugins.install.methods")}</div>
              <ul className="space-y-1">
                {methods.map((m) => (
                  <li key={m.name} className="text-xs text-fg-2">
                    <span className="font-mono">{m.name}</span>
                    {(m.permissions ?? []).length > 0 ? (
                      <span className="text-muted"> · {(m.permissions ?? []).join(", ")}</span>
                    ) : null}
                    {m.dangerAction ? (
                      <span className="text-danger"> · danger:{m.dangerAction}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-muted">{t("plugins.install.confirmHint")}</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <WorkbenchActionButton onClick={onCancel} disabled={confirming}>
            {t("common.cancel")}
          </WorkbenchActionButton>
          <WorkbenchActionButton onClick={onConfirm} disabled={confirming}>
            {confirming ? t("plugins.catalog.installing") : t("plugins.install.confirm")}
          </WorkbenchActionButton>
        </div>
      </div>
    </Modal>
  );
}

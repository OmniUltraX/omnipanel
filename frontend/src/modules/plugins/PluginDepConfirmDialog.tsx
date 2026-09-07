import type { ResolvePlan } from "../../ipc/bindings";
import { Modal } from "../../components/ui/overlay/Modal";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import { useI18n } from "../../i18n";

type Props = {
  plan: ResolvePlan;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function PluginDepConfirmDialog({ plan, confirming, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  return (
    <Modal open onClose={onCancel}>
      <div className="bg-bg-deeper border border-border rounded-lg shadow-2xl w-[520px] max-w-[92vw]">
        <WorkbenchPanelHeader label={t("plugins.deps.title")} />
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-muted">{t("plugins.deps.hint")}</p>
          <ul className="space-y-1">
            {plan.items.map((step) => (
              <li key={`${step.id}@${step.version}`} className="text-xs text-fg-2">
                <span className="font-mono">{step.id}</span>
                <span className="text-muted"> · v{step.version}</span>
                <span className="text-muted"> · {t(`plugins.deps.action.${step.action}`)}</span>
                <span className="text-muted"> · {step.sourceId}</span>
              </li>
            ))}
          </ul>
          {plan.warnings.length > 0 ? (
            <ul className="space-y-1">
              {plan.warnings.map((warning) => (
                <li key={warning} className="text-xs text-danger">
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <WorkbenchActionButton onClick={onCancel} disabled={confirming}>
            {t("common.cancel")}
          </WorkbenchActionButton>
          <WorkbenchActionButton onClick={onConfirm} disabled={confirming || plan.items.length === 0}>
            {confirming ? t("plugins.catalog.installing") : t("plugins.install.confirm")}
          </WorkbenchActionButton>
        </div>
      </div>
    </Modal>
  );
}

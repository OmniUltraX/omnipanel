import { Modal } from "../../components/ui/overlay/Modal";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import { useI18n } from "../../i18n";
import { runPluginEnsure } from "../../lib/pluginEnsure";
import { usePluginEnsureStore } from "../../stores/pluginEnsureStore";

/** 同步缺件的第三方插件确认。挂在 App 根，不进插件中心路由。 */
export function PluginEnsureHost() {
  const { t } = useI18n();
  const pending = usePluginEnsureStore((state) => state.pending);
  const confirming = usePluginEnsureStore((state) => state.confirming);
  const setConfirming = usePluginEnsureStore((state) => state.setConfirming);
  const clearPending = usePluginEnsureStore((state) => state.clearPending);

  if (pending.length === 0) return null;

  const onCancel = () => {
    if (confirming) return;
    clearPending();
  };

  const onConfirm = () => {
    if (confirming) return;
    const ids = pending.map((item) => item.id);
    setConfirming(true);
    void runPluginEnsure(ids).finally(() => {
      usePluginEnsureStore.getState().clearPending();
    });
  };

  return (
    <Modal open onClose={onCancel}>
      <div className="bg-bg-deeper border border-border rounded-lg shadow-2xl w-[520px] max-w-[92vw]">
        <WorkbenchPanelHeader label={t("plugins.ensure.confirmTitle")} />
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-muted">{t("plugins.ensure.confirmHint")}</p>
          <ul className="space-y-2">
            {pending.map((item) => (
              <li key={item.id} className="text-xs text-fg-2">
                <div>
                  <span className="font-mono">{item.id}</span>
                  {item.name && item.name !== item.id ? (
                    <span className="text-muted"> · {item.name}</span>
                  ) : null}
                  <span className="text-muted"> · {item.sourceId}</span>
                </div>
                <div className="text-muted mt-0.5">
                  {item.permissions.length === 0
                    ? t("plugins.install.noPermissions")
                    : item.permissions.join(", ")}
                </div>
              </li>
            ))}
          </ul>
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

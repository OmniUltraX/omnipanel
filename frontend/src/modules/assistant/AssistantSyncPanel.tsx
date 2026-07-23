import { useI18n } from "../../i18n";
import { showToast } from "../../stores/toastStore";
import { Button } from "../../components/ui/Button";
import { useAssistantPush } from "./useAssistantPush";

type AssistantSyncPanelProps = {
  /** 可选：关联的绑定 id */
  bindId?: string | null;
};

/** 设备管理等场景：手动将本机元数据快照同步到 OSS（助手端通道）。 */
export function AssistantSyncPanel({ bindId }: AssistantSyncPanelProps) {
  const { t } = useI18n();
  const { phase, result, error, push } = useAssistantPush();
  const busy = phase === "pushing";

  return (
    <div className="assistant-sync-panel">
      <p className="assistant-sync-panel__desc">
        {t("userCenter.devices.assistantSync.desc")}
      </p>
      <div className="assistant-sync-panel__actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            void push({ dryRun: true, bindId })
              .then((r) => {
                showToast(
                  t("userCenter.devices.assistantSync.dryRunOk", {
                    bytes: String(r.bytes),
                  }),
                );
              })
              .catch(() => {
                /* toast via error state */
              });
          }}
        >
          {t("userCenter.devices.assistantSync.dryRun")}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => {
            void push({ dryRun: false, bindId })
              .then((r) => {
                showToast(
                  t("userCenter.devices.assistantSync.success", {
                    key: r.objectKey,
                  }),
                );
              })
              .catch(() => {});
          }}
        >
          {busy
            ? t("userCenter.devices.assistantSync.pushing")
            : t("userCenter.devices.assistantSync.push")}
        </Button>
      </div>
      {phase === "error" && error ? (
        <p className="assistant-sync-panel__error">{error}</p>
      ) : null}
      {phase === "success" && result ? (
        <p className="assistant-sync-panel__meta">
          {result.dryRun
            ? t("userCenter.devices.assistantSync.dryRunMeta", {
                bytes: String(result.bytes),
              })
            : t("userCenter.devices.assistantSync.meta", {
                key: result.objectKey,
                bytes: String(result.bytes),
              })}
        </p>
      ) : null}
    </div>
  );
}

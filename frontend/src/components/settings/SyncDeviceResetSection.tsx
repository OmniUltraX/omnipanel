import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
import { ensureSyncDeviceAuth } from "../../lib/auth/ensureSyncDeviceAuth";
import { resetSyncDevice } from "../../lib/auth/syncPairingApi";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { Button } from "../ui/primitives/Button";

/**
 * 系统设置：「重置设备」——清除本机 SyncMasterKey，并调用服务端 reset，回到未认证状态。
 * 已同步密钥时显示「已认证」标签。
 */
export function SyncDeviceResetSection() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [hasKey, setHasKey] = useState(false);
  const [ready, setReady] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await unwrapCommand(commands.syncMasterKeyStatus(), { quiet: true });
      setHasKey(Boolean(status.hasKey));
    } catch {
      setHasKey(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleReset = async () => {
    if (!(await appConfirm(t("settings.data.resetDeviceConfirm")))) return;
    setResetting(true);
    setError(null);
    setNotice(null);
    try {
      try {
        await unwrapCommand(commands.secretsVaultLock(), { quiet: true });
      } catch {
        /* 未解锁时忽略 */
      }
      await unwrapCommand(commands.syncMasterKeyClear());
      useSyncDeviceAuthStore.getState().reset();
      const authToken = token?.trim();
      if (authToken) {
        try {
          await resetSyncDevice(authToken);
        } catch {
          /* 服务端失败时仍完成本地重置 */
        }
      }
      setHasKey(false);
      setNotice(t("settings.data.resetDeviceDone"));
      if (authToken) {
        void ensureSyncDeviceAuth();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setResetting(false);
      void refreshStatus();
    }
  };

  return (
    <>
      <div className="setting-row">
        <div className="setting-label">
          <h4 className="setting-label-with-tag">
            {t("settings.data.resetDeviceLabel")}
            {ready && hasKey ? (
              <span className="setting-auth-tag">{t("settings.data.authenticatedTag")}</span>
            ) : null}
          </h4>
          <p>{t("settings.data.resetDeviceDesc")}</p>
        </div>
        <div className="setting-row-actions">
          <Button
            variant="danger"
            size="sm"
            disabled={resetting || !hasKey}
            onClick={() => void handleReset()}
          >
            {resetting ? t("settings.data.clearing") : t("settings.data.resetDeviceBtn")}
          </Button>
        </div>
      </div>

      {notice ? (
        <p className="settings-data-notice" style={{ color: "var(--success)", marginTop: "var(--sp-3)" }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="settings-data-error" style={{ color: "var(--danger)", marginTop: "var(--sp-3)" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}

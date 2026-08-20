import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
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

      // 先阻断旧版静默迁移，再清密钥，避免并发 ensure 立刻重建
      useSyncDeviceAuthStore.getState().markResetPendingAuth();
      await unwrapCommand(commands.syncMasterKeyClear());

      const authToken = token?.trim();
      let serverResetFailed: string | null = null;
      if (authToken) {
        try {
          await resetSyncDevice(authToken);
        } catch (e) {
          serverResetFailed = e instanceof Error ? e.message : formatIpcError(e);
        }
      }

      // 再次确认本机已无密钥（防止并发路径重建）
      const status = await unwrapCommand(commands.syncMasterKeyStatus(), { quiet: true });
      if (status.hasKey) {
        await unwrapCommand(commands.syncMasterKeyClear());
      }

      setHasKey(false);
      if (serverResetFailed) {
        setNotice(t("settings.data.resetDeviceDoneLocalOnly"));
        setError(serverResetFailed);
      } else {
        setNotice(t("settings.data.resetDeviceDone"));
      }
      // 保持 markResetPendingAuth 打开的认证对话框；勿再走 ensureSyncDeviceAuth（会静默迁移）
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setResetting(false);
      await refreshStatus();
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

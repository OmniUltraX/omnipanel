import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
import { resetSyncDevice } from "../../lib/auth/syncPairingApi";
import { pullCloudSnapshot } from "../../modules/clientSync";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/primitives/Button";

/**
 * 系统设置：「重置设备」——清除本机 SyncMasterKey，并调用服务端 reset，回到未认证状态。
 * 已同步密钥时显示「已认证」标签；并提供「立即拉取」以补拉云端快照。
 */
export function SyncDeviceResetSection() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [hasKey, setHasKey] = useState(false);
  const [ready, setReady] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [pulling, setPulling] = useState(false);
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

  const handlePullNow = async () => {
    if (!token?.trim() || pulling) return;
    setPulling(true);
    setError(null);
    setNotice(null);
    try {
      const pulled = await pullCloudSnapshot();
      if (!pulled.ok) {
        setError(t("settings.data.pullNowFailed"));
        return;
      }
      if (pulled.modulesFound || pulled.conversationsFound) {
        const msg = t("settings.data.pullNowDone", {
          connections: String(pulled.appliedConnections),
          databases: String(pulled.appliedDatabases),
        });
        setNotice(msg);
        showToast(msg);
      } else {
        setNotice(t("settings.data.pullNowEmpty"));
        showToast(t("settings.data.pullNowEmpty"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setPulling(false);
    }
  };

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
      const status = await unwrapCommand(commands.syncMasterKeyStatus());
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
            {t("settings.data.pullNowLabel")}
            {ready && hasKey ? (
              <span className="setting-auth-tag">{t("settings.data.authenticatedTag")}</span>
            ) : null}
          </h4>
          <p>{t("settings.data.pullNowDesc")}</p>
        </div>
        <div className="setting-row-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={pulling || !token?.trim()}
            onClick={() => void handlePullNow()}
          >
            {pulling ? t("settings.data.clearing") : t("settings.data.pullNowBtn")}
          </Button>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.data.resetDeviceLabel")}</h4>
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { LocalQrCode } from "./LocalQrCode";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import {
  pullCloudSnapshot,
  scheduleClientModuleSync,
  scheduleSecretsVaultSync,
} from "../../modules/clientSync";

type PendingItem = {
  pairing_id: string;
  requester_device_id: string;
  requester_pubkey: string;
  created_at: string;
  verification_code?: string;
  device_name?: string;
};

type QrSession = {
  pairingId: string;
  verificationCode: string;
  expiresAt: string;
  qrPayload: string;
};

/**
 * SyncMasterKey 管理与新设备扫码配对。
 * 已就绪且无待办时不渲染；密钥明文不展示。
 */
export function DeviceSecretsVaultPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const ossPath = useUserProfileStore((s) => s.ossPath);

  const [hasKey, setHasKey] = useState(false);
  const [qrSession, setQrSession] = useState<QrSession | null>(null);
  const [qrCountdown, setQrCountdown] = useState(0);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const bootstrap = useCallback(async () => {
    try {
      const status = await unwrapCommand(commands.syncMasterKeyStatus());
      setHasKey(Boolean(status.hasKey));
      setReady(true);
    } catch (error) {
      showToast(formatIpcError(error));
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!token || !hasKey) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { pairingPending } = await import("../../lib/auth/syncPairingApi");
        const items = await pairingPending(token);
        if (!cancelled) setPending(items);
      } catch {
        if (!cancelled) setPending([]);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, hasKey]);

  useEffect(() => {
    if (!qrSession?.expiresAt) {
      setQrCountdown(0);
      return;
    }
    const tick = () => {
      const left = Math.max(
        0,
        Math.floor((Date.parse(qrSession.expiresAt) - Date.now()) / 1000),
      );
      setQrCountdown(left);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [qrSession]);

  const tryTrust = async (authToken: string) => {
    try {
      const { trustSyncDevice } = await import("../../lib/auth/syncPairingApi");
      await trustSyncDevice(authToken);
    } catch {
      /* 服务端未部署时忽略 */
    }
  };

  const ensureLocalMasterKeyForWrap = async (): Promise<boolean> => {
    try {
      const status = await unwrapCommand(commands.syncMasterKeyStatus());
      if (status.hasKey) return true;
      await unwrapCommand(commands.syncMasterKeyGetOrCreate());
      setHasKey(true);
      scheduleSecretsVaultSync();
      return true;
    } catch {
      return false;
    }
  };

  const waitForWrappedKey = async (pairingId: string, deviceId: string) => {
    const { pairingGet } = await import("../../lib/auth/syncPairingApi");
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await pairingGet(token!, pairingId);
      if (st.status === "rejected" || st.status === "expired") {
        showToast(t("userCenter.devices.vault.pairingRejected"));
        return false;
      }
      if (st.status === "completed" && st.wrapped_key) {
        await unwrapCommand(
          commands.syncPairingUnwrapAndStore(pairingId, deviceId, st.wrapped_key),
        );
        const status = await unwrapCommand(commands.syncMasterKeyStatus());
        if (status.hasKey) {
          setHasKey(true);
          void (async () => {
            const pulled = await pullCloudSnapshot();
            if (pulled.ok) {
              if (pulled.modulesFound) {
                scheduleClientModuleSync();
              }
              scheduleSecretsVaultSync();
            }
          })();
        }
        showToast(t("userCenter.devices.vault.pairingKeyReady"));
        return true;
      }
    }
    showToast(t("userCenter.devices.vault.pairingWaitKey"));
    return false;
  };

  const handleApprovePending = async (item: PendingItem) => {
    if (!token || busy) return;
    setBusy(true);
    try {
      if (!(await ensureLocalMasterKeyForWrap())) {
        showToast(t("userCenter.devices.vault.wrapNeedKey"));
        return;
      }
      if (token) await tryTrust(token);
      const wrapped = await unwrapCommand(
        commands.syncPairingWrapKey({
          pairingId: item.pairing_id,
          requesterDeviceId: item.requester_device_id,
          requesterPubkeyB64: item.requester_pubkey,
        }),
      );
      const { pairingWrap } = await import("../../lib/auth/syncPairingApi");
      await pairingWrap(token, {
        pairing_id: item.pairing_id,
        wrapped_key: wrapped.wrappedKey,
        wrap_alg: wrapped.wrapAlg,
      });
      setPending((prev) => prev.filter((p) => p.pairing_id !== item.pairing_id));
      showToast(t("userCenter.devices.vault.pairingApproved"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : formatIpcError(error as never));
    } finally {
      setBusy(false);
    }
  };

  const handleStartQrPairing = async () => {
    if (!token || busy) return;
    setBusy(true);
    try {
      const { pairingStart } = await import("../../lib/auth/syncPairingApi");
      const identity = await unwrapCommand(commands.authDeviceIdentity());
      const kp = await unwrapCommand(commands.syncPairingCreateKeypair(""));
      const started = await pairingStart(token, {
        pubkey: kp.pubkeyB64,
        client_nonce: crypto.randomUUID(),
        device_name: identity.deviceId,
        platform: navigator.platform || "desktop",
      });
      await unwrapCommand(commands.syncPairingCreateKeypair(started.pairing_id));
      const payload = `omni://sync-pair?v=1&id=${encodeURIComponent(started.pairing_id)}`;
      setQrSession({
        pairingId: started.pairing_id,
        verificationCode: started.verification_code,
        expiresAt: started.expires_at,
        qrPayload: payload,
      });
      showToast(t("userCenter.devices.vault.qrWaiting"));
      void (async () => {
        const ok = await waitForWrappedKey(started.pairing_id, identity.deviceId);
        if (ok) setQrSession(null);
      })();
    } catch (error) {
      showToast(error instanceof Error ? error.message : formatIpcError(error as never));
    } finally {
      setBusy(false);
    }
  };

  const handleCancelQr = async () => {
    if (!token || !qrSession) {
      setQrSession(null);
      return;
    }
    try {
      const { pairingReject } = await import("../../lib/auth/syncPairingApi");
      await pairingReject(token, qrSession.pairingId);
    } catch {
      /* ignore */
    }
    setQrSession(null);
  };

  const qrExpireLabel = useMemo(() => {
    const m = Math.floor(qrCountdown / 60);
    const s = qrCountdown % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [qrCountdown]);

  const showSetup = !hasKey && ready && !qrSession;
  const showPending = pending.length > 0;
  const showOssWarn = !ossPath.trim() && !hasKey && ready;

  if (ready && hasKey && !qrSession && !showPending) {
    return null;
  }

  if (!ready) {
    return null;
  }

  return (
    <section className="user-center-section user-center-vault" aria-label={t("userCenter.devices.vault.title")}>
      {showSetup ? (
        <div className="user-center-vault__actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || !token}
            onClick={() => void handleStartQrPairing()}
          >
            {t("userCenter.devices.vault.qrStart")}
          </Button>
        </div>
      ) : null}

      {qrSession ? (
        <div className="user-center-vault__qr" role="status">
          <LocalQrCode payload={qrSession.qrPayload} size={200} className="user-center-vault__qr-img" />
          <p className="user-center-vault__vc">
            {t("userCenter.devices.vault.verificationCode")}:{" "}
            <strong>{qrSession.verificationCode}</strong>
          </p>
          <p className="user-center-section__desc">{t("userCenter.devices.vault.qrHint")}</p>
          <p className="user-center-section__desc">
            {t("userCenter.devices.vault.qrExpire", { time: qrExpireLabel })}
          </p>
          <div className="user-center-vault__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void handleCancelQr()}>
              {t("userCenter.devices.vault.qrCancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {showOssWarn ? (
        <p className="user-center-section__desc user-center-vault__warn">
          {t("userCenter.devices.vault.needOssPath")}
        </p>
      ) : null}

      {showPending ? (
        <div className="user-center-vault__pending">
          {pending.map((item) => (
            <div key={item.pairing_id} className="user-center-vault__pending-row">
              <div className="user-center-vault__pending-meta">
                <code>{item.device_name || item.requester_device_id}</code>
                {item.verification_code ? (
                  <span>
                    {t("userCenter.devices.vault.verificationCode")}: {item.verification_code}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void handleApprovePending(item)}
              >
                {t("userCenter.devices.vault.retryTransfer")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

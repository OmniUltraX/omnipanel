import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { LocalQrCode } from "./LocalQrCode";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import {
  pullSecretsVaultOnce,
  scheduleSecretsVaultSync,
} from "../../modules/clientSync";

type QrSession = {
  pairingId: string;
  verificationCode: string;
  expiresAt: string;
  qrPayload: string;
};

/**
 * 本机无 SyncMasterKey 时弹出：请用微信小程序扫码认证本设备。
 * 主设备在线时会自动传钥；成功后拉取密文库并关闭。
 */
export function SyncDeviceAuthDialog() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const open = useSyncDeviceAuthStore((s) => s.open);
  const closeDialog = useSyncDeviceAuthStore((s) => s.closeDialog);
  const dismissForToken = useSyncDeviceAuthStore((s) => s.dismissForToken);

  const [session, setSession] = useState<QrSession | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitingKey, setWaitingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<QrSession | null>(null);
  const pollGenRef = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const startPairing = useCallback(async () => {
    const authToken = useAuthStore.getState().token?.trim();
    if (!authToken) return;

    setBusy(true);
    setError(null);
    setWaitingKey(false);
    const pollGen = ++pollGenRef.current;

    try {
      const { pairingStart, pairingReject, pairingGet } = await import(
        "../../lib/auth/syncPairingApi"
      );
      const prev = sessionRef.current;
      if (prev?.pairingId) {
        try {
          await pairingReject(authToken, prev.pairingId);
        } catch {
        }
      }

      const identity = await unwrapCommand(commands.authDeviceIdentity());
      const kp = await unwrapCommand(commands.syncPairingCreateKeypair(""));
      const started = await pairingStart(authToken, {
        pubkey: kp.pubkeyB64,
        client_nonce: crypto.randomUUID(),
        device_name: identity.deviceId,
        platform: navigator.platform || "desktop",
      });
      await unwrapCommand(commands.syncPairingCreateKeypair(started.pairing_id));
      const next: QrSession = {
        pairingId: started.pairing_id,
        verificationCode: started.verification_code,
        expiresAt: started.expires_at,
        qrPayload: `omni://sync-pair?v=1&id=${encodeURIComponent(started.pairing_id)}`,
      };
      setSession(next);
      setWaitingKey(true);

      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (pollGen !== pollGenRef.current) return;
        if (!useSyncDeviceAuthStore.getState().open) return;
        try {
          const st = await pairingGet(authToken, next.pairingId);
          if (st.status === "rejected" || st.status === "expired") {
            setError(t("userCenter.devices.vault.pairingRejected"));
            setWaitingKey(false);
            return;
          }
          if (st.status === "completed" && st.wrapped_key) {
            await unwrapCommand(
              commands.syncPairingUnwrapAndStore(
                next.pairingId,
                identity.deviceId,
                st.wrapped_key,
              ),
            );
            await pullSecretsVaultOnce();
            scheduleSecretsVaultSync();
            showToast(t("syncDeviceAuth.success"));
            closeDialog();
            setSession(null);
            setWaitingKey(false);
            return;
          }
        } catch {
        }
      }
      if (pollGen === pollGenRef.current) {
        setWaitingKey(false);
        setError(t("syncDeviceAuth.timeout"));
      }
    } catch (err) {
      if (pollGen === pollGenRef.current) {
        setError(err instanceof Error ? err.message : formatIpcError(err));
        setSession(null);
        setWaitingKey(false);
      }
    } finally {
      if (pollGen === pollGenRef.current) setBusy(false);
    }
  }, [closeDialog, t]);

  useEffect(() => {
    if (!open || !token?.trim()) return;
    void startPairing();
    return () => {
      pollGenRef.current += 1;
    };
  }, [open, token, startPairing]);

  useEffect(() => {
    if (!session?.expiresAt) {
      setCountdown(0);
      return;
    }
    const tick = () => {
      const left = Math.max(
        0,
        Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
      );
      setCountdown(left);
      if (left <= 0) setWaitingKey(false);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [session?.expiresAt]);

  const expireLabel = useMemo(() => {
    const m = Math.floor(countdown / 60);
    const s = countdown % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [countdown]);

  const handleLater = () => {
    pollGenRef.current += 1;
    const tok = useAuthStore.getState().token?.trim();
    if (tok) dismissForToken(tok);
    else closeDialog();
    setSession(null);
    setWaitingKey(false);
    setError(null);
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={handleLater}>
      <div
        className="sync-device-auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-device-auth-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sync-device-auth-dialog__header">
          <h3 id="sync-device-auth-title">{t("syncDeviceAuth.title")}</h3>
        </div>
        <p className="sync-device-auth-dialog__hint">{t("syncDeviceAuth.hint")}</p>

        {session ? (
          <>
            <LocalQrCode
              payload={session.qrPayload}
              size={220}
              className="sync-device-auth-dialog__qr"
              alt={t("syncDeviceAuth.qrAlt")}
            />
            <p className="sync-device-auth-dialog__code">
              {t("syncDeviceAuth.verificationCode")}:{" "}
              <strong>{session.verificationCode}</strong>
            </p>
            <p className="sync-device-auth-dialog__expire">
              {countdown > 0
                ? t("syncDeviceAuth.expire", { time: expireLabel })
                : t("syncDeviceAuth.expired")}
            </p>
            {waitingKey ? (
              <p className="sync-device-auth-dialog__status">
                {t("syncDeviceAuth.waiting")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="sync-device-auth-dialog__hint">
            {busy ? t("syncDeviceAuth.loading") : t("syncDeviceAuth.needRefresh")}
          </p>
        )}

        {error ? <p className="sync-device-auth-dialog__error">{error}</p> : null}

        <div className="sync-device-auth-dialog__actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void startPairing()}
          >
            {t("syncDeviceAuth.refresh")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={handleLater}>
            {t("syncDeviceAuth.later")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

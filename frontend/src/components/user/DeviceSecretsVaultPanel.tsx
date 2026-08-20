import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { LocalQrCode } from "./LocalQrCode";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import {
  getDeviceSyncCode,
  isValidDeviceCode,
  useDeviceSyncCodeStore,
} from "../../stores/deviceSyncCodeStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

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
 * SyncMasterKey 密文库同步。
 * 首台生成并备份；新设备走路径 B（动态码）或路径 C（扫码）；主设备有密钥时自动传钥。
 * 路径 A（粘贴 SMK 入网）已移除。
 */
export function DeviceSecretsVaultPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const ossPath = useUserProfileStore((s) => s.ossPath);
  const legacyCode = useDeviceSyncCodeStore((s) => s.deviceCode);

  const [key, setKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [qrSession, setQrSession] = useState<QrSession | null>(null);
  const [qrCountdown, setQrCountdown] = useState(0);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [showBackupHint, setShowBackupHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [needsMigration, setNeedsMigration] = useState(false);

  const bootstrap = useCallback(async () => {
    try {
      const status = await unwrapCommand(commands.syncMasterKeyStatus());
      if (status.hasKey && status.key) {
        setKey(status.key);
        setReady(true);
        setNeedsMigration(false);
        return;
      }
      setKey("");
      setReady(true);
      try {
        const vault = await unwrapCommand(commands.secretsVaultStatus());
        setNeedsMigration(Boolean(vault.hasLocalSalt));
      } catch {
        setNeedsMigration(false);
      }
    } catch (error) {
      showToast(formatIpcError(error));
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!token || !key) return;
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
  }, [token, key]);

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

  const canSync = Boolean(token && ossPath.trim() && key && !busy);
  const keyReady = Boolean(key);

  const tryTrust = async (authToken: string) => {
    try {
      const { trustSyncDevice } = await import("../../lib/auth/syncPairingApi");
      await trustSyncDevice(authToken);
    } catch {
      /* 服务端未部署时忽略 */
    }
  };

  const tryPullWithPassword = async (password: string) => {
    if (!token || !ossPath.trim()) return;
    await unwrapCommand(
      commands.secretsVaultPull({
        token,
        deviceCode: password,
        ossPath: ossPath.trim(),
      }),
    );
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
        if (status.key) {
          setKey(status.key);
          setNeedsMigration(false);
        }
        showToast(t("userCenter.devices.vault.pairingKeyReady"));
        return true;
      }
    }
    showToast(t("userCenter.devices.vault.pairingWaitKey"));
    return false;
  };

  const handleGeneratePrimary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await unwrapCommand(commands.syncMasterKeyGetOrCreate());
      setKey(created.key);
      setNeedsMigration(false);
      if (created.created) setShowBackupHint(true);
      showToast(t("userCenter.devices.vault.generateSuccess"));
    } catch (error) {
      showToast(formatIpcError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleMigrateFromLegacy = async () => {
    if (busy) return;
    const oldCode = isValidDeviceCode(legacyCode) ? legacyCode : getDeviceSyncCode();
    if (!isValidDeviceCode(oldCode)) {
      showToast(t("userCenter.devices.vault.codeInvalid"));
      return;
    }
    setBusy(true);
    try {
      await unwrapCommand(commands.secretsVaultUnlock(oldCode));
      try {
        await tryPullWithPassword(oldCode);
      } catch {
        /* 云端无库时仅完成本地升级 */
      }
      const created = await unwrapCommand(commands.syncMasterKeyGetOrCreate());
      await unwrapCommand(commands.secretsVaultUnlock(created.key));
      if (token && ossPath.trim()) {
        await unwrapCommand(
          commands.secretsVaultPush({
            token,
            deviceCode: created.key,
            ossPath: ossPath.trim(),
          }),
        );
        await tryTrust(token);
      }
      setKey(created.key);
      setNeedsMigration(false);
      setShowBackupHint(true);
      showToast(t("userCenter.devices.vault.migrateSuccess"));
    } catch (error) {
      showToast(formatIpcError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleApprovePending = async (item: PendingItem) => {
    if (!token || busy) return;
    setBusy(true);
    try {
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

  const handleCopy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      showToast(t("userCenter.devices.vault.copied"));
    } catch {
      showToast(t("userCenter.devices.vault.copyFailed"));
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

  const handlePairingRedeem = async () => {
    if (!token || pairingCode.length < 6 || busy) return;
    setBusy(true);
    try {
      const { pairingStart, pairingRedeem } = await import("../../lib/auth/syncPairingApi");
      const identity = await unwrapCommand(commands.authDeviceIdentity());
      const deviceId = identity.deviceId;
      const kp = await unwrapCommand(commands.syncPairingCreateKeypair(""));
      const started = await pairingStart(token, {
        pubkey: kp.pubkeyB64,
        client_nonce: crypto.randomUUID(),
        device_name: deviceId,
        platform: navigator.platform || "desktop",
      });
      await unwrapCommand(commands.syncPairingCreateKeypair(started.pairing_id));
      await pairingRedeem(token, {
        pairing_id: started.pairing_id,
        code: pairingCode,
      });
      setPairingCode("");
      showToast(t("userCenter.devices.vault.pairingTrusted"));
      await waitForWrappedKey(started.pairing_id, deviceId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : formatIpcError(error as never));
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    if (!canSync) return;
    setBusy(true);
    try {
      await unwrapCommand(commands.secretsVaultUnlock(key));
      const result = await unwrapCommand(
        commands.secretsVaultPush({
          token: token!,
          deviceCode: key,
          ossPath: ossPath.trim(),
        }),
      );
      await tryTrust(token!);
      showToast(t("userCenter.devices.vault.syncSuccess", { n: result.secretCount }));
    } catch (error) {
      showToast(formatIpcError(error));
    } finally {
      setBusy(false);
    }
  };

  const masked = key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key || "—";
  const qrExpireLabel = useMemo(() => {
    const m = Math.floor(qrCountdown / 60);
    const s = qrCountdown % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [qrCountdown]);

  return (
    <section className="user-center-section user-center-vault">
      <h3 className="user-center-section__title">{t("userCenter.devices.vault.title")}</h3>
      <p className="user-center-section__desc">{t("userCenter.devices.vault.smkDesc")}</p>

      {needsMigration && !keyReady ? (
        <div className="user-center-vault__backup-banner" role="status">
          <p>{t("userCenter.devices.vault.migrateHint")}</p>
          <div className="user-center-vault__actions">
            <Button type="button" size="sm" disabled={busy} onClick={() => void handleMigrateFromLegacy()}>
              {t("userCenter.devices.vault.migrate")}
            </Button>
          </div>
        </div>
      ) : null}

      {!keyReady && ready ? (
        <div className="user-center-vault__setup">
          <p className="user-center-section__desc">{t("userCenter.devices.vault.setupHint")}</p>
          <div className="user-center-vault__actions">
            <Button type="button" size="sm" disabled={busy} onClick={() => void handleGeneratePrimary()}>
              {t("userCenter.devices.vault.generatePrimary")}
            </Button>
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
        </div>
      ) : null}

      {qrSession ? (
        <div className="user-center-vault__qr" role="status">
          <p className="user-center-section__desc">{t("userCenter.devices.vault.qrHint")}</p>
          <LocalQrCode payload={qrSession.qrPayload} size={200} className="user-center-vault__qr-img" />
          <p className="user-center-vault__vc">
            {t("userCenter.devices.vault.verificationCode")}:{" "}
            <strong>{qrSession.verificationCode}</strong>
          </p>
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

      {showBackupHint && keyReady ? (
        <div className="user-center-vault__backup-banner" role="status">
          <p>{t("userCenter.devices.vault.backupHint")}</p>
          <div className="user-center-vault__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy()}>
              {t("userCenter.devices.vault.copyKey")}
            </Button>
            <Button type="button" size="sm" onClick={() => setShowBackupHint(false)}>
              {t("userCenter.devices.vault.backupDone")}
            </Button>
          </div>
        </div>
      ) : null}

      {keyReady ? (
        <div className="user-center-vault__key-row">
          <code className="user-center-vault__key">{revealed ? key || "…" : masked}</code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!ready || !key}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? t("userCenter.devices.vault.hideKey") : t("userCenter.devices.vault.showKey")}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!key} onClick={() => void handleCopy()}>
            {t("userCenter.devices.vault.copyKey")}
          </Button>
        </div>
      ) : null}

      {!keyReady ? (
        <>
          <label className="user-center-vault__import-label">
            {t("userCenter.devices.vault.pairingLabel")}
            <input
              className="user-center-vault__import"
              value={pairingCode}
              disabled={busy}
              maxLength={8}
              inputMode="numeric"
              placeholder="123456"
              onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
          </label>
          <div className="user-center-vault__actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || pairingCode.length < 6 || !token}
              onClick={() => void handlePairingRedeem()}
            >
              {t("userCenter.devices.vault.pairingRedeem")}
            </Button>
          </div>
        </>
      ) : null}

      {keyReady ? (
        <div className="user-center-vault__actions">
          <Button type="button" variant="secondary" size="sm" disabled={!canSync} onClick={() => void handleSync()}>
            {t("userCenter.devices.vault.sync")}
          </Button>
        </div>
      ) : null}

      {!ossPath.trim() ? (
        <p className="user-center-section__desc user-center-vault__warn">
          {t("userCenter.devices.vault.needOssPath")}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <div className="user-center-vault__pending">
          <h4 className="user-center-section__title">{t("userCenter.devices.vault.pendingTitle")}</h4>
          <p className="user-center-section__desc">{t("userCenter.devices.vault.pendingAutoHint")}</p>
          {pending.map((item) => (
            <div key={item.pairing_id} className="user-center-vault__pending-row">
              <div className="user-center-vault__pending-meta">
                <code>{item.device_name || item.requester_device_id}</code>
                {item.verification_code ? (
                  <span>
                    {t("userCenter.devices.vault.verificationCode")}: {item.verification_code}
                  </span>
                ) : null}
                <span>{t("userCenter.devices.vault.pendingAutoStatus")}</span>
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

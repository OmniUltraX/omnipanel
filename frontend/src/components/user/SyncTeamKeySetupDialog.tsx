import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import {
  importSyncTeamKeyFile,
  requestTeamSyncKeyFromRelay,
  SyncKeyRelayError,
} from "../../lib/auth/syncKeyRelayApi";
import {
  pullCloudSnapshot,
  scheduleClientModuleSync,
  scheduleSecretsVaultSync,
} from "../../modules/clientSync";

type Phase = "requesting" | "waiting" | "no_peer" | "import" | "error";

/**
 * 本机无团队同步密钥时弹出：自动向在线设备请求密钥，或引导导入 `.omnipanel-sync.key`。
 */
export function SyncTeamKeySetupDialog() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const open = useSyncDeviceAuthStore((s) => s.open);
  const closeDialog = useSyncDeviceAuthStore((s) => s.closeDialog);
  const dismissForToken = useSyncDeviceAuthStore((s) => s.dismissForToken);

  const [phase, setPhase] = useState<Phase>("requesting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const runGenRef = useRef(0);

  const afterKeyReady = useCallback(async () => {
    const pulled = await pullCloudSnapshot();
    if (pulled.ok) {
      if (pulled.modulesFound) {
        scheduleClientModuleSync();
      }
      scheduleSecretsVaultSync();
      if (pulled.modulesFound || pulled.conversationsFound) {
        showToast(
          t("syncTeamKeySetup.successWithData", {
            connections: String(pulled.appliedConnections),
            databases: String(pulled.appliedDatabases),
          }),
        );
      } else {
        showToast(t("syncTeamKeySetup.successNoCloudData"));
      }
    } else {
      showToast(t("syncTeamKeySetup.pullFailed"));
    }
    closeDialog();
  }, [closeDialog, t]);

  const startRelayRequest = useCallback(async () => {
    const authToken = useAuthStore.getState().token?.trim();
    if (!authToken) return;
    const teamId = getCurrentSyncTeamId();
    if (!teamId) {
      setPhase("import");
      setError(t("syncTeamKeySetup.noTeam"));
      return;
    }

    const gen = ++runGenRef.current;
    setBusy(true);
    setError(null);
    setPhase("requesting");

    try {
      const identity = await unwrapCommand(commands.authDeviceIdentity());
      setPhase("waiting");
      const result = await requestTeamSyncKeyFromRelay({
        token: authToken,
        teamId,
        deviceId: identity.deviceId,
        timeoutMs: 90_000,
      });
      if (gen !== runGenRef.current) return;
      showToast(t("syncTeamKeySetup.keyReceived", { fingerprint: result.fingerprint }));
      await afterKeyReady();
    } catch (e) {
      if (gen !== runGenRef.current) return;
      if (e instanceof SyncKeyRelayError && e.code === "no_online_peer") {
        setPhase("no_peer");
        setError(e.message);
        return;
      }
      if (e instanceof SyncKeyRelayError && e.code === "timeout") {
        setPhase("no_peer");
        setError(t("syncTeamKeySetup.timeout"));
        return;
      }
      setPhase("error");
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      if (gen === runGenRef.current) setBusy(false);
    }
  }, [afterKeyReady, t]);

  useEffect(() => {
    if (!open || !token?.trim()) return;
    void startRelayRequest();
    return () => {
      runGenRef.current += 1;
    };
  }, [open, token, startRelayRequest]);

  const handleImport = async () => {
    const authToken = useAuthStore.getState().token?.trim();
    const teamId = getCurrentSyncTeamId();
    if (!authToken || !teamId) {
      setError(t("syncTeamKeySetup.noTeam"));
      return;
    }
    const path = await openFileDialog({
      multiple: false,
      filters: [{ name: "OmniPanel Sync Key", extensions: ["omnipanel-sync.key", "key", "json"] }],
    });
    if (!path || Array.isArray(path)) return;

    setBusy(true);
    setError(null);
    try {
      const result = await importSyncTeamKeyFile(path, {
        teamId,
        passphrase: passphrase.trim() || null,
      });
      showToast(t("syncTeamKeySetup.importDone", { fingerprint: result.fingerprint }));
      await afterKeyReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleLater = () => {
    runGenRef.current += 1;
    const tok = useAuthStore.getState().token?.trim();
    if (tok) dismissForToken(tok);
    else closeDialog();
    setError(null);
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={handleLater}>
      <div
        className="sync-device-auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-team-key-setup-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sync-device-auth-dialog__header">
          <h3 id="sync-team-key-setup-title">{t("syncTeamKeySetup.title")}</h3>
        </div>
        <p className="sync-device-auth-dialog__hint">{t("syncTeamKeySetup.hint")}</p>

        {phase === "requesting" || phase === "waiting" ? (
          <p className="sync-device-auth-dialog__status">
            {phase === "requesting"
              ? t("syncTeamKeySetup.requesting")
              : t("syncTeamKeySetup.waiting")}
          </p>
        ) : null}

        {phase === "no_peer" || phase === "import" || phase === "error" ? (
          <>
            <p className="sync-device-auth-dialog__hint">{t("syncTeamKeySetup.importHint")}</p>
            <input
              type="password"
              className="setting-input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={t("settings.syncTeamKey.passphrasePlaceholder")}
              autoComplete="new-password"
            />
          </>
        ) : null}

        {error ? <p className="sync-device-auth-dialog__error">{error}</p> : null}

        <div className="sync-device-auth-dialog__actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void startRelayRequest()}
          >
            {t("syncTeamKeySetup.retryRelay")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void handleImport()}
          >
            {t("syncTeamKeySetup.importBtn")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={handleLater}>
            {t("syncTeamKeySetup.later")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

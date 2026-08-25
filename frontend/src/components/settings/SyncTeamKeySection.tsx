import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { formatIpcError } from "../../ipc/result";
import {
  exportSyncTeamKeyFile,
  getSyncTeamKeyStatus,
  importSyncTeamKeyFile,
} from "../../lib/auth/syncTeamKeyApi";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/primitives/Button";

/**
 * 系统设置：团队同步密钥（v2）导出 / 导入与指纹展示。
 */
export function SyncTeamKeySection() {
  const { t } = useI18n();
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const teamId = getCurrentSyncTeamId();
    if (!teamId) {
      setHasKey(false);
      setFingerprint(null);
      setReady(true);
      return;
    }
    try {
      const status = await getSyncTeamKeyStatus(teamId);
      setHasKey(Boolean(status.hasKey));
      setFingerprint(status.fingerprint ?? null);
    } catch {
      setHasKey(false);
      setFingerprint(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleExport = async () => {
    if (busy) return;
    const teamId = getCurrentSyncTeamId();
    if (!teamId) {
      setError(t("settings.syncTeamKey.noTeam"));
      return;
    }
    const path = await saveFileDialog({
      defaultPath: `team-${teamId}.omnipanel-sync.key`,
      filters: [{ name: "OmniPanel Sync Key", extensions: ["omnipanel-sync.key", "key", "json"] }],
    });
    if (!path) return;

    setBusy(true);
    setError(null);
    try {
      await exportSyncTeamKeyFile(path, {
        teamId,
        passphrase: passphrase.trim() || null,
      });
      showToast(t("settings.syncTeamKey.exportDone"));
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (busy) return;
    const teamId = getCurrentSyncTeamId();
    if (!teamId) {
      setError(t("settings.syncTeamKey.noTeam"));
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
      setFingerprint(result.fingerprint);
      setHasKey(true);
      showToast(t("settings.syncTeamKey.importDone", { fingerprint: result.fingerprint }));
    } catch (e) {
      setError(e instanceof Error ? e.message : formatIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return null;

  return (
    <div className="settings-subsection sync-team-key-section">
      <div className="settings-subsection-title">{t("settings.syncTeamKey.label")}</div>
      <p className="setting-hint settings-subsection-desc">{t("settings.syncTeamKey.desc")}</p>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.syncTeamKey.statusLabel")}</h4>
          <p className="setting-hint">
            {hasKey && fingerprint
              ? t("settings.syncTeamKey.statusHasKey", { fingerprint })
              : t("settings.syncTeamKey.statusMissing")}
          </p>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.syncTeamKey.passphraseLabel")}</h4>
          <p className="setting-hint">{t("settings.syncTeamKey.passphraseHint")}</p>
        </div>
        <input
          type="password"
          className="setting-input"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t("settings.syncTeamKey.passphrasePlaceholder")}
          autoComplete="new-password"
        />
      </div>

      <div className="setting-row setting-row-actions">
        <Button variant="secondary" disabled={busy || !hasKey} onClick={() => void handleExport()}>
          {t("settings.syncTeamKey.exportBtn")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void handleImport()}>
          {t("settings.syncTeamKey.importBtn")}
        </Button>
      </div>

      {error ? <p className="setting-error">{error}</p> : null}
    </div>
  );
}

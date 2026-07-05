import { useState } from "react";
import { useI18n } from "../../i18n";
import { clearAppLayoutCache, clearAppUserData } from "../../lib/appDataReset";
import { appConfirm } from "../../lib/appConfirm";
import { Button } from "../ui/primitives/Button";

export function DataBackupSection() {
  const { t } = useI18n();
  const [clearingCache, setClearingCache] = useState(false);
  const [clearingUserData, setClearingUserData] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClearCache = async () => {
    if (!(await appConfirm(t("settings.data.clearCacheConfirm")))) return;
    setClearingCache(true);
    setError(null);
    setNotice(null);
    try {
      clearAppLayoutCache();
      setNotice(t("settings.data.clearCacheDone"));
    } catch (e) {
      setError(String(e));
    } finally {
      setClearingCache(false);
    }
  };

  const handleClearUserData = async () => {
    if (!(await appConfirm(t("settings.data.clearUserDataConfirm")))) return;
    setClearingUserData(true);
    setError(null);
    setNotice(null);
    try {
      await clearAppUserData();
      setNotice(t("settings.data.clearUserDataDone"));
    } catch (e) {
      setError(String(e));
    } finally {
      setClearingUserData(false);
    }
  };

  return (
    <div className="settings-panel active">
      <div className="settings-section">
        <h2>{t("settings.data.title")}</h2>
        <p className="section-desc">{t("settings.data.description")}</p>

        <div className="setting-row">
          <div className="setting-label">
            <h4>{t("settings.data.clearCacheLabel")}</h4>
            <p>{t("settings.data.clearCacheDesc")}</p>
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={clearingCache || clearingUserData}
            onClick={() => void handleClearCache()}
          >
            {clearingCache ? t("settings.data.clearing") : t("settings.data.clearCacheBtn")}
          </Button>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <h4>{t("settings.data.clearUserDataLabel")}</h4>
            <p>{t("settings.data.clearUserDataDesc")}</p>
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={clearingCache || clearingUserData}
            onClick={() => void handleClearUserData()}
          >
            {clearingUserData ? t("settings.data.clearing") : t("settings.data.clearUserDataBtn")}
          </Button>
        </div>

        {notice && (
          <p className="settings-data-notice" style={{ color: "var(--success)", marginTop: "var(--sp-3)" }}>
            {notice}
          </p>
        )}
        {error && (
          <p className="settings-data-error" style={{ color: "var(--danger)", marginTop: "var(--sp-3)" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

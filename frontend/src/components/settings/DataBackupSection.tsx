import { useState } from "react";
import { useI18n } from "../../i18n";
import { clearAppLayoutCache, clearAppUserData } from "../../lib/appDataReset";
import { appConfirm } from "../../lib/appConfirm";
import { Button } from "../ui/primitives/Button";

/**
 * 系统设置内的「用户数据」一项：合并原缓存页的清理能力，并提供清除缓存按钮。
 */
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
    <>
      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.data.userDataLabel")}</h4>
          <p>{t("settings.data.userDataDesc")}</p>
        </div>
        <div className="setting-row-actions">
          <Button
            variant="danger"
            size="sm"
            disabled={clearingCache || clearingUserData}
            onClick={() => void handleClearCache()}
          >
            {clearingCache ? t("settings.data.clearing") : t("settings.data.clearCacheBtn")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={clearingCache || clearingUserData}
            onClick={() => void handleClearUserData()}
          >
            {clearingUserData ? t("settings.data.clearing") : t("settings.data.clearUserDataBtn")}
          </Button>
        </div>
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
    </>
  );
}

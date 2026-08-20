import { useState } from "react";
import { useI18n } from "../../i18n";
import { clearAppCache } from "../../lib/appDataReset";
import { appConfirm } from "../../lib/appConfirm";
import { Button } from "../ui/primitives/Button";

/**
 * 系统设置内的「用户数据」一项：一键清除缓存（含布局习惯与全部用户资源）。
 */
export function DataBackupSection() {
  const { t } = useI18n();
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClearCache = async () => {
    if (!(await appConfirm(t("settings.data.clearCacheConfirm")))) return;
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      await clearAppCache();
      setNotice(t("settings.data.clearCacheDone"));
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
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
            disabled={clearing}
            onClick={() => void handleClearCache()}
          >
            {clearing ? t("settings.data.clearing") : t("settings.data.clearCacheBtn")}
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

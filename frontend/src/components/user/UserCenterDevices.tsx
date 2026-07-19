import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import {
  fetchDeviceIdentity,
  fetchDevices,
  isAuthSessionError,
  type AuthDevice,
} from "../../lib/auth/loginApi";
import { useAuthStore } from "../../stores/authStore";
import { Button } from "../ui/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { IconMonitor } from "../ui/icons/Icons";

function formatDeviceTime(value: string, locale: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "—";
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toLocaleString(locale);
}

function formatOsLabel(
  osType: string,
  t: (key: string) => string,
): string {
  const normalized = osType.trim().toLowerCase();
  if (normalized === "windows" || normalized.includes("win")) {
    return t("userCenter.devices.os.windows");
  }
  if (normalized === "macos" || normalized === "darwin" || normalized.includes("mac")) {
    return t("userCenter.devices.os.macos");
  }
  if (normalized === "linux") {
    return t("userCenter.devices.os.linux");
  }
  return osType.trim() || t("userCenter.devices.os.unknown");
}

export function UserCenterDevices() {
  const { t, locale } = useI18n();
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);

  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setDevices([]);
      setErrorMessage(t("userCenter.devices.sessionExpired"));
      setSessionExpired(true);
      return;
    }

    const abort = new AbortController();
    setLoading(true);
    setErrorMessage(null);
    setSessionExpired(false);

    void (async () => {
      try {
        const [identity, list] = await Promise.all([
          fetchDeviceIdentity(),
          fetchDevices(token),
        ]);
        if (abort.signal.aborted) return;
        setLocalDeviceId(identity.deviceId);
        setDevices(list);
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setDevices([]);
        setErrorMessage(message);
        setSessionExpired(isAuthSessionError(error));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => abort.abort();
  }, [token, refreshKey, t]);

  if (loading) {
    return (
      <div className="user-center-content user-center-content--empty">
        <p className="user-center-devices__hint">{t("userCenter.devices.loading")}</p>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="user-center-content">
        <section className="user-center-section">
          <h3 className="user-center-section__title">{t("userCenter.devices.title")}</h3>
          <p className="user-center-section__desc user-center-devices__error">{errorMessage}</p>
          <div className="user-center-devices__actions">
            {sessionExpired ? (
              <Button type="button" variant="secondary" size="sm" onClick={logout}>
                {t("userCenter.logout")}
              </Button>
            ) : (
              <Button type="button" variant="secondary" size="sm" onClick={refresh}>
                {t("userCenter.devices.retry")}
              </Button>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="user-center-content user-center-content--empty">
        <ModuleEmptyState
          icon={<IconMonitor size={36} />}
          title={t("userCenter.devices.emptyTitle")}
          desc={t("userCenter.devices.emptyDesc")}
        />
        <div className="user-center-devices__actions">
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            {t("userCenter.devices.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="user-center-content">
      <section className="user-center-section">
        <div className="user-center-devices__header">
          <div>
            <h3 className="user-center-section__title">{t("userCenter.devices.title")}</h3>
            <p className="user-center-section__desc">{t("userCenter.devices.desc")}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            {t("userCenter.devices.refresh")}
          </Button>
        </div>

        <ul className="user-center-device-list">
          {devices.map((device) => {
            const isCurrent = Boolean(localDeviceId && device.deviceId === localDeviceId);
            const name = device.deviceName.trim() || device.deviceId || t("userCenter.devices.unnamed");
            return (
              <li
                key={device.id || device.deviceId || `${device.ip}-${device.lastLoginAt}`}
                className={`user-center-device-item${isCurrent ? " is-current" : ""}`}
              >
                <div className="user-center-device-item__icon" aria-hidden>
                  <IconMonitor size={16} />
                </div>
                <div className="user-center-device-item__body">
                  <div className="user-center-device-item__title-row">
                    <span className="user-center-device-item__name">{name}</span>
                    {isCurrent ? (
                      <span className="user-center-device-item__badge">
                        {t("userCenter.devices.current")}
                      </span>
                    ) : null}
                  </div>
                  <div className="user-center-device-item__meta">
                    <span>{formatOsLabel(device.osType, t)}</span>
                    <span>{device.ip.trim() || t("userCenter.devices.unknownIp")}</span>
                    <span>
                      {t("userCenter.devices.lastLogin")}:{" "}
                      {formatDeviceTime(device.lastLoginAt, locale)}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

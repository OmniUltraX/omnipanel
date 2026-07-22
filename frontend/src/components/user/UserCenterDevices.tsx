import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import {
  deleteDevice,
  fetchDeviceIdentity,
  fetchDevices,
  isAuthSessionError,
  type AuthDevice,
} from "../../lib/auth/loginApi";
import { appConfirm } from "../../lib/appConfirm";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { IconMonitor } from "../ui/icons/Icons";
import { BindAssistantDialog } from "./BindAssistantDialog";

function formatDeviceTime(value: string, locale: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "—";
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toLocaleString(locale);
}

function formatOsLabel(osType: string, t: (key: string) => string): string {
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

function normalizeRole(role: string | undefined): "client" | "assistant" {
  return role?.trim().toLowerCase() === "assistant" ? "assistant" : "client";
}

function DeviceList({
  devices,
  localDeviceId,
  deletingId,
  onDelete,
  t,
  locale,
}: {
  devices: AuthDevice[];
  localDeviceId: string | null;
  deletingId: string | null;
  onDelete: (device: AuthDevice) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
}) {
  if (devices.length === 0) {
    return <p className="user-center-devices__group-empty">{t("userCenter.devices.groupEmpty")}</p>;
  }

  return (
    <ul className="user-center-device-list">
      {devices.map((device) => {
        const isCurrent = Boolean(localDeviceId && device.deviceId === localDeviceId);
        const name = device.deviceName.trim() || device.deviceId || t("userCenter.devices.unnamed");
        const busy = deletingId === device.deviceId;
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="user-center-device-item__delete"
              disabled={Boolean(deletingId)}
              onClick={() => onDelete(device)}
            >
              {busy ? t("userCenter.devices.deleting") : t("userCenter.devices.delete")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function UserCenterDevices() {
  const { t, locale } = useI18n();
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const clearProfile = useUserProfileStore((s) => s.clearProfile);

  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bindOpen, setBindOpen] = useState(false);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const handleSessionExpired = useCallback(() => {
    clearProfile();
    logout();
    showToast(t("userCenter.devices.sessionExpired"));
  }, [clearProfile, logout, t]);

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
          fetchDevices(token, { quiet: true }),
        ]);
        if (abort.signal.aborted) return;
        setLocalDeviceId(identity.deviceId);
        setDevices(list);
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        const cause =
          error instanceof Error
            ? String((error as Error & { cause?: unknown }).cause ?? "")
            : "";
        const networkHint =
          /error sending request|连接|network|proxy|timed out|timeout/i.test(
            `${message} ${cause}`,
          )
            ? t("userCenter.devices.networkHint")
            : null;
        setDevices([]);
        setErrorMessage(networkHint ?? message);
        setSessionExpired(isAuthSessionError(error));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => abort.abort();
  }, [token, refreshKey, t]);

  const { clientDevices, assistantDevices } = useMemo(() => {
    const clients: AuthDevice[] = [];
    const assistants: AuthDevice[] = [];
    for (const device of devices) {
      if (normalizeRole(device.role) === "assistant") {
        assistants.push(device);
      } else {
        clients.push(device);
      }
    }
    return { clientDevices: clients, assistantDevices: assistants };
  }, [devices]);

  const handleDelete = useCallback(
    async (device: AuthDevice) => {
      if (!token || !device.deviceId || deletingId) return;
      const isCurrent = Boolean(localDeviceId && device.deviceId === localDeviceId);
      const name = device.deviceName.trim() || device.deviceId || t("userCenter.devices.unnamed");
      const confirmed = await appConfirm(
        isCurrent
          ? t("userCenter.devices.deleteCurrentConfirm", { name })
          : t("userCenter.devices.deleteConfirm", { name }),
        t("userCenter.devices.deleteTitle"),
        { kind: "warning", confirmLabel: t("userCenter.devices.delete") },
      );
      if (!confirmed) return;

      setDeletingId(device.deviceId);
      try {
        await deleteDevice(token, device.deviceId);
        setDevices((prev) => prev.filter((item) => item.deviceId !== device.deviceId));
        showToast(t("userCenter.devices.deleteSuccess"));
        if (isCurrent) {
          clearProfile();
          logout();
        }
      } catch (error) {
        if (isAuthSessionError(error)) {
          handleSessionExpired();
        } else {
          showToast(
            error instanceof Error ? error.message : t("userCenter.devices.deleteFailed"),
          );
        }
      } finally {
        setDeletingId(null);
      }
    },
    [clearProfile, deletingId, handleSessionExpired, localDeviceId, logout, t, token],
  );

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

  return (
    <div className="user-center-content">
      <section className="user-center-section">
        <div className="user-center-devices__header">
          <div>
            <h3 className="user-center-section__title">{t("userCenter.devices.title")}</h3>
            <p className="user-center-section__desc">{t("userCenter.devices.desc")}</p>
          </div>
          <div className="user-center-devices__header-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!token}
              onClick={() => setBindOpen(true)}
            >
              {t("userCenter.devices.bind.action")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={refresh}>
              {t("userCenter.devices.refresh")}
            </Button>
          </div>
        </div>

        {devices.length === 0 ? (
          <ModuleEmptyState
            icon={<IconMonitor size={36} />}
            title={t("userCenter.devices.emptyTitle")}
            desc={t("userCenter.devices.emptyDesc")}
          />
        ) : (
          <>
            <div className="user-center-devices__group">
              <h4 className="user-center-devices__group-title">
                {t("userCenter.devices.role.client")}
                <span className="user-center-devices__group-count">{clientDevices.length}</span>
              </h4>
              <DeviceList
                devices={clientDevices}
                localDeviceId={localDeviceId}
                deletingId={deletingId}
                onDelete={(device) => void handleDelete(device)}
                t={t}
                locale={locale}
              />
            </div>

            <div className="user-center-devices__group">
              <div className="user-center-devices__group-header">
                <h4 className="user-center-devices__group-title">
                  {t("userCenter.devices.role.assistant")}
                  <span className="user-center-devices__group-count">{assistantDevices.length}</span>
                </h4>
              </div>
              <DeviceList
                devices={assistantDevices}
                localDeviceId={localDeviceId}
                deletingId={deletingId}
                onDelete={(device) => void handleDelete(device)}
                t={t}
                locale={locale}
              />
            </div>
          </>
        )}
      </section>

      {token ? (
        <BindAssistantDialog
          open={bindOpen}
          token={token}
          onClose={() => setBindOpen(false)}
          onBound={refresh}
          onSessionExpired={handleSessionExpired}
        />
      ) : null}
    </div>
  );
}

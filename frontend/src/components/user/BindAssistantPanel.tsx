import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import {
  fetchBindingsQrcode,
  isAuthSessionError,
  waitForBindings,
  type BindingsQrcodeResponse,
} from "../../lib/auth/loginApi";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/Button";
import { LocalQrCode } from "./LocalQrCode";

type BindUiStatus = "loading" | "ready" | "expired" | "error" | "success";

interface BindAssistantPanelProps {
  active: boolean;
  token: string;
  onBound: () => void;
  onClose: () => void;
  onSessionExpired: () => void;
}

/** 设备管理页内联：申请绑定二维码并 SSE 等待助手端扫码确认。 */
export function BindAssistantPanel({
  active,
  token,
  onBound,
  onClose,
  onSessionExpired,
}: BindAssistantPanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<BindUiStatus>("loading");
  const [qrcode, setQrcode] = useState<BindingsQrcodeResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const waitAbortRef = useRef<AbortController | null>(null);
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWait = useCallback(() => {
    waitAbortRef.current?.abort();
    waitAbortRef.current = null;
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
  }, []);

  const refreshQrcode = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!active || !token) {
      clearWait();
      return;
    }

    const fetchAbort = new AbortController();
    clearWait();
    setStatus("loading");
    setErrorMessage(null);
    setQrcode(null);

    void (async () => {
      try {
        const data = await fetchBindingsQrcode(token);
        if (fetchAbort.signal.aborted) return;

        setQrcode(data);
        setStatus("ready");

        const expireMs = Math.max(1, data.expire_in_sec || 300) * 1000;
        expireTimerRef.current = setTimeout(() => {
          waitAbortRef.current?.abort();
          waitAbortRef.current = null;
          setStatus("expired");
        }, expireMs);

        const waitAbort = new AbortController();
        waitAbortRef.current = waitAbort;
        await waitForBindings(token, data.bind_id, {
          signal: waitAbort.signal,
          expireInSec: data.expire_in_sec,
        });
        if (waitAbort.signal.aborted || fetchAbort.signal.aborted) return;

        setStatus("success");
        showToast(t("userCenter.devices.bind.success"));
        onBound();
        onClose();
      } catch (error) {
        if (fetchAbort.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (isAuthSessionError(error)) {
          onSessionExpired();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof Error ? ((error as Error & { code?: string }).code ?? null) : null;
        if (code === "timeout" || message.includes("已结束") || message.includes("已断开")) {
          setStatus("expired");
          setErrorMessage(message);
          return;
        }
        setStatus("error");
        setErrorMessage(message || t("userCenter.devices.bind.error"));
      }
    })();

    return () => {
      fetchAbort.abort();
      clearWait();
    };
  }, [active, clearWait, onBound, onClose, onSessionExpired, refreshKey, t, token]);

  if (!active) return null;

  const statusText =
    status === "loading"
      ? t("userCenter.devices.bind.loading")
      : status === "ready"
        ? t("userCenter.devices.bind.waiting")
        : status === "expired"
          ? t("userCenter.devices.bind.expired")
          : status === "error"
            ? errorMessage || t("userCenter.devices.bind.error")
            : t("userCenter.devices.bind.success");

  return (
    <div className="user-center-bind-panel">
      <p className="user-center-section__desc">{t("userCenter.devices.bind.desc")}</p>
      <div className="user-center-login__qr-wrap user-center-bind-panel__qr">
        {status === "ready" && qrcode ? (
          <LocalQrCode
            payload={qrcode.qr_payload}
            size={180}
            className="user-center-login__qr"
            alt={t("userCenter.devices.bind.qrAlt")}
          />
        ) : (
          <div className="user-center-login__qr-placeholder" aria-busy={status === "loading"}>
            {status === "loading" ? t("userCenter.devices.bind.loading") : null}
          </div>
        )}
        {(status === "expired" || status === "error") && (
          <div className="user-center-login__qr-mask">
            <Button type="button" variant="secondary" size="sm" onClick={refreshQrcode}>
              {t("userCenter.devices.bind.refresh")}
            </Button>
          </div>
        )}
      </div>
      <p
        className={`user-center-login__status${
          status === "expired" || status === "error" ? " is-warn" : ""
        }`}
      >
        {statusText}
      </p>
    </div>
  );
}

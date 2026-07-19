import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import {
  fetchLoginQrcode,
  waitForLogin,
  type LoginQrcodeResponse,
} from "../../lib/auth/loginApi";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

type LoginUiStatus = "loading" | "ready" | "expired" | "error";

export function WechatLoginPanel() {
  const { t } = useI18n();
  const setSession = useAuthStore((s) => s.setSession);

  const [status, setStatus] = useState<LoginUiStatus>("loading");
  const [qrcode, setQrcode] = useState<LoginQrcodeResponse | null>(null);
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
    const fetchAbort = new AbortController();
    clearWait();
    setStatus("loading");
    setErrorMessage(null);
    setQrcode(null);

    void (async () => {
      try {
        const data = await fetchLoginQrcode(fetchAbort.signal);
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
        const payload = await waitForLogin(data.login_id, {
          signal: waitAbort.signal,
          expireInSec: data.expire_in_sec,
        });
        if (waitAbort.signal.aborted || fetchAbort.signal.aborted) return;

        setSession({ token: payload.token, openid: payload.openid });
        const profile = useUserProfileStore.getState();
        if (!profile.displayName.trim() && payload.openid) {
          profile.setDisplayName(payload.openid.slice(0, 8));
        }
      } catch (error) {
        if (fetchAbort.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus((prev) => (prev === "expired" ? prev : "error"));
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      fetchAbort.abort();
      clearWait();
    };
  }, [clearWait, refreshKey, setSession]);

  const statusText =
    status === "loading"
      ? t("userCenter.login.loading")
      : status === "ready"
        ? t("userCenter.login.waiting")
        : status === "expired"
          ? t("userCenter.login.expired")
          : errorMessage || t("userCenter.login.error");

  return (
    <div className="user-center-login">
      <div className="user-center-login__card">
        <h3 className="user-center-login__title">{t("userCenter.login.title")}</h3>
        <p className="user-center-login__desc">{t("userCenter.login.desc")}</p>

        <div className="user-center-login__qr-wrap">
          {status === "ready" && qrcode?.qrcode_url ? (
            <img
              className="user-center-login__qr"
              src={qrcode.qrcode_url}
              alt={t("userCenter.login.qrAlt")}
            />
          ) : (
            <div className="user-center-login__qr-placeholder" aria-hidden>
              {status === "loading" ? "…" : "!"}
            </div>
          )}
          {(status === "expired" || status === "error") && (
            <div className="user-center-login__qr-mask">
              <Button type="button" variant="secondary" size="sm" onClick={refreshQrcode}>
                {t("userCenter.login.refresh")}
              </Button>
            </div>
          )}
        </div>

        <p
          className={`user-center-login__status${
            status === "error" || status === "expired" ? " is-warn" : ""
          }`}
        >
          {statusText}
        </p>
      </div>
    </div>
  );
}

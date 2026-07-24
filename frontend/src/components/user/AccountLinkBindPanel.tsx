import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "../../i18n";
import { formatIpcError } from "../../ipc/result";
import {
  fetchMe,
  fetchWechatLinkQrcode,
  isAuthSessionError,
  linkEmail,
  linkGithub,
  sendEmailLinkCode,
  waitForWechatLink,
  type LoginQrcodeResponse,
} from "../../lib/auth/loginApi";
import { showToast } from "../../stores/toastStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/form/TextInput";

export type AccountLinkKind = "wechat" | "github" | "email";

interface AccountLinkBindPanelProps {
  kind: AccountLinkKind;
  token: string;
  onClose: () => void;
  onLinked: () => void;
  onSessionExpired: () => void;
}

type WechatUiStatus = "loading" | "ready" | "expired" | "error" | "success";

async function refreshProfileFromMe(token: string) {
  const me = await fetchMe(token);
  useUserProfileStore.getState().setProfile({
    nickname: me.nickname,
    avatarUrl: me.avatarUrl,
    openid: me.openid,
    email: me.email,
    githubId: me.githubId,
  });
}

function WechatLinkPanel({
  token,
  onLinked,
  onSessionExpired,
}: {
  token: string;
  onLinked: () => void;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<WechatUiStatus>("loading");
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

  useEffect(() => {
    if (!token) {
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
        const data = await fetchWechatLinkQrcode(token);
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
        await waitForWechatLink(token, data.login_id, {
          signal: waitAbort.signal,
          expireInSec: data.expire_in_sec,
        });
        if (waitAbort.signal.aborted || fetchAbort.signal.aborted) return;

        await refreshProfileFromMe(token);
        setStatus("success");
        showToast(t("userCenter.accountLinks.wechatSuccess"));
        onLinked();
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
        if (
          code === "timeout" ||
          (error instanceof Error && error.name === "WechatLinkWaitDisconnected") ||
          message.includes("已结束") ||
          message.includes("已断开")
        ) {
          setStatus("expired");
          setErrorMessage(message);
          return;
        }
        setStatus("error");
        setErrorMessage(message || t("userCenter.accountLinks.wechatError"));
      }
    })();

    return () => {
      fetchAbort.abort();
      clearWait();
    };
  }, [clearWait, onLinked, onSessionExpired, refreshKey, t, token]);

  const statusText =
    status === "loading"
      ? t("userCenter.accountLinks.wechatLoading")
      : status === "ready"
        ? t("userCenter.accountLinks.wechatWaiting")
        : status === "expired"
          ? t("userCenter.accountLinks.wechatExpired")
          : status === "error"
            ? errorMessage || t("userCenter.accountLinks.wechatError")
            : t("userCenter.accountLinks.wechatSuccess");

  return (
    <div className="user-center-account-bind">
      <p className="user-center-section__desc">{t("userCenter.accountLinks.wechatDesc")}</p>
      <div className="user-center-login__qr-wrap user-center-account-bind__qr">
        {status === "ready" && qrcode?.qrcode_url ? (
          <img
            className="user-center-login__qr"
            src={qrcode.qrcode_url}
            alt={t("userCenter.accountLinks.wechatQrAlt")}
          />
        ) : (
          <div className="user-center-login__qr-placeholder" aria-busy={status === "loading"}>
            {status === "loading" ? "…" : "!"}
          </div>
        )}
        {(status === "expired" || status === "error") && (
          <div className="user-center-login__qr-mask">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              {t("userCenter.accountLinks.wechatRefresh")}
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

function EmailLinkPanel({
  token,
  onLinked,
  onSessionExpired,
}: {
  token: string;
  onLinked: () => void;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const onSendCode = useCallback(async () => {
    if (sending || cooldown > 0) return;
    const trimmed = email.trim();
    if (!trimmed) {
      setError(t("userCenter.accountLinks.emailRequired"));
      return;
    }
    setSending(true);
    setError(null);
    setHint(null);
    try {
      const sent = await sendEmailLinkCode(token, trimmed);
      setCooldown(Math.max(1, sent.expireInSec || 60));
      if (sent.code) {
        setCode(sent.code);
        setHint(
          sent.hint
            ? `${sent.hint}（${t("userCenter.accountLinks.devCode")}: ${sent.code}）`
            : `${t("userCenter.accountLinks.devCode")}: ${sent.code}`,
        );
      } else {
        setHint(sent.hint || t("userCenter.accountLinks.codeSent"));
      }
    } catch (err) {
      if (isAuthSessionError(err)) {
        onSessionExpired();
        return;
      }
      setError(formatIpcError(err));
    } finally {
      setSending(false);
    }
  }, [cooldown, email, onSessionExpired, sending, t, token]);

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (submitting) return;
      const trimmedEmail = email.trim();
      const trimmedCode = code.trim();
      if (!trimmedEmail) {
        setError(t("userCenter.accountLinks.emailRequired"));
        return;
      }
      if (!trimmedCode) {
        setError(t("userCenter.accountLinks.codeRequired"));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const me = await linkEmail(token, trimmedEmail, trimmedCode);
        useUserProfileStore.getState().setProfile({
          nickname: me.nickname,
          avatarUrl: me.avatarUrl,
          openid: me.openid,
          email: me.email,
          githubId: me.githubId,
        });
        showToast(t("userCenter.accountLinks.emailSuccess"));
        onLinked();
      } catch (err) {
        if (isAuthSessionError(err)) {
          onSessionExpired();
          return;
        }
        setError(formatIpcError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [code, email, onLinked, onSessionExpired, submitting, t, token],
  );

  return (
    <form className="user-center-account-bind user-center-account-bind__form" onSubmit={(e) => void onSubmit(e)}>
      <p className="user-center-section__desc">{t("userCenter.accountLinks.emailDesc")}</p>
      <label className="user-center-account-bind__field">
        <span className="user-center-field__label">{t("userCenter.accountLinks.emailLabel")}</span>
        <TextInput
          className="input"
          value={email}
          onChange={setEmail}
          placeholder={t("userCenter.accountLinks.emailPlaceholder")}
          autoComplete="email"
          copyable={false}
        />
      </label>
      <label className="user-center-account-bind__field">
        <span className="user-center-field__label">{t("userCenter.accountLinks.codeLabel")}</span>
        <div className="user-center-account-bind__code-row">
          <TextInput
            className="input"
            value={code}
            onChange={setCode}
            placeholder={t("userCenter.accountLinks.codePlaceholder")}
            autoComplete="one-time-code"
            copyable={false}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={sending || cooldown > 0}
            onClick={() => void onSendCode()}
          >
            {cooldown > 0
              ? t("userCenter.accountLinks.resendIn", { sec: cooldown })
              : sending
                ? t("userCenter.accountLinks.sending")
                : t("userCenter.accountLinks.sendCode")}
          </Button>
        </div>
      </label>
      {hint ? <p className="user-center-account-bind__hint">{hint}</p> : null}
      {error ? <p className="user-center-account-bind__hint is-error">{error}</p> : null}
      <div className="user-center-account-bind__actions">
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting
            ? t("userCenter.accountLinks.binding")
            : t("userCenter.accountLinks.bindEmail")}
        </Button>
      </div>
    </form>
  );
}

function GithubLinkPanel({
  token,
  onLinked,
  onSessionExpired,
}: {
  token: string;
  onLinked: () => void;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onBind = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await linkGithub(token);
      await refreshProfileFromMe(token);
      showToast(t("userCenter.accountLinks.githubSuccess"));
      onLinked();
    } catch (err) {
      if (isAuthSessionError(err)) {
        onSessionExpired();
        return;
      }
      setError(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  }, [busy, onLinked, onSessionExpired, t, token]);

  return (
    <div className="user-center-account-bind">
      <p className="user-center-section__desc">{t("userCenter.accountLinks.githubDesc")}</p>
      <div className="user-center-account-bind__actions">
        <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => void onBind()}>
          {busy ? t("userCenter.accountLinks.githubWaiting") : t("userCenter.accountLinks.bindGithub")}
        </Button>
      </div>
      {error ? <p className="user-center-account-bind__hint is-error">{error}</p> : null}
    </div>
  );
}

/** 个人中心：微信扫码 / 邮箱验证码 / GitHub OAuth 绑定面板。 */
export function AccountLinkBindPanel({
  kind,
  token,
  onClose,
  onLinked,
  onSessionExpired,
}: AccountLinkBindPanelProps) {
  const { t } = useI18n();
  const title =
    kind === "wechat"
      ? t("userCenter.accountLinks.bindWechatTitle")
      : kind === "github"
        ? t("userCenter.accountLinks.bindGithubTitle")
        : t("userCenter.accountLinks.bindEmailTitle");

  return (
    <div className="user-center-account-bind-shell">
      <div className="user-center-account-bind-shell__head">
        <h4 className="user-center-account-bind-shell__title">{title}</h4>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("userCenter.accountLinks.cancel")}
        </Button>
      </div>
      {kind === "wechat" ? (
        <WechatLinkPanel token={token} onLinked={onLinked} onSessionExpired={onSessionExpired} />
      ) : null}
      {kind === "email" ? (
        <EmailLinkPanel token={token} onLinked={onLinked} onSessionExpired={onSessionExpired} />
      ) : null}
      {kind === "github" ? (
        <GithubLinkPanel token={token} onLinked={onLinked} onSessionExpired={onSessionExpired} />
      ) : null}
    </div>
  );
}

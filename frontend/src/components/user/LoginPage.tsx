import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../../i18n";
import { AppLogo } from "../ui/layout/AppLogo";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/form/TextInput";
import { WechatLoginPanel } from "./WechatLoginPanel";
import { WinControls } from "../shell/WinControls";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import {
  fetchMe,
  loginWithEmail,
  loginWithGithub,
  cancelGithubLogin,
  sendEmailLoginCode,
} from "../../lib/auth/loginApi";
import { formatIpcError } from "../../ipc/result";
import wechatIcon from "../../assets/icons/login/wechat.svg";
import githubDarkIcon from "../../assets/icons/login/github_dark.svg";
import githubLightIcon from "../../assets/icons/login/github_light.svg";
import emailIcon from "../../assets/icons/login/email.svg";

type LoginMethod = "wechat" | "github" | "email";

function useGithubIcon(): string {
  const resolved = useSettingsStore((s) => s.resolved);
  return resolved === "light" ? githubLightIcon : githubDarkIcon;
}

async function applyLoginSession(token: string, openid: string): Promise<void> {
  useAuthStore.getState().setSession({ token, openid });
  try {
    const me = await fetchMe(token);
    useUserProfileStore.getState().setProfile({
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
      openid: me.openid,
      email: me.email,
      githubId: me.githubId,
    });
  } catch {
    const profile = useUserProfileStore.getState();
    if (!profile.nickname.trim() && openid) {
      profile.setNickname(openid.slice(0, 8));
    }
  }
}

function GithubLoginPanel() {
  const { t } = useI18n();
  const githubIcon = useGithubIcon();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await loginWithGithub();
      await applyLoginSession(payload.token, payload.openid);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  useEffect(() => {
    return () => {
      void cancelGithubLogin();
    };
  }, []);

  return (
    <div className="login-page__panel">
      <p className="login-page__panel-desc">{t("app.login.github.desc")}</p>
      <Button
        type="button"
        variant="secondary"
        className="login-page__oauth-btn"
        disabled={busy}
        onClick={() => void onLogin()}
      >
        <img src={githubIcon} alt="" width={16} height={16} aria-hidden />
        {busy ? t("app.login.github.waiting") : t("app.login.github.action")}
      </Button>
      {error ? <p className="login-page__hint is-error">{error}</p> : null}
    </div>
  );
}

function EmailLoginPanel() {
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
      setError(t("app.login.email.emailRequired"));
      return;
    }
    setSending(true);
    setError(null);
    setHint(null);
    try {
      const sent = await sendEmailLoginCode(trimmed);
      setCooldown(Math.max(1, sent.expireInSec || 60));
      if (sent.code) {
        setCode(sent.code);
        setHint(
          sent.hint
            ? `${sent.hint}（${t("app.login.email.devCode")}: ${sent.code}）`
            : `${t("app.login.email.devCode")}: ${sent.code}`,
        );
      } else {
        setHint(sent.hint || t("app.login.email.codeSent"));
      }
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setSending(false);
    }
  }, [cooldown, email, sending, t]);

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (submitting) return;
      const trimmedEmail = email.trim();
      const trimmedCode = code.trim();
      if (!trimmedEmail) {
        setError(t("app.login.email.emailRequired"));
        return;
      }
      if (!trimmedCode) {
        setError(t("app.login.email.codeRequired"));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const payload = await loginWithEmail(trimmedEmail, trimmedCode);
        await applyLoginSession(payload.token, payload.openid);
      } catch (err) {
        setError(formatIpcError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [code, email, submitting, t],
  );

  return (
    <form className="login-page__panel login-page__form" onSubmit={(e) => void onSubmit(e)}>
      <label className="login-page__field">
        <span className="login-page__field-label">{t("app.login.email.label")}</span>
        <TextInput
          value={email}
          onChange={setEmail}
          placeholder={t("app.login.email.placeholder")}
          autoComplete="username"
          copyable={false}
          size="md"
        />
      </label>
      <label className="login-page__field">
        <span className="login-page__field-label">{t("app.login.email.code")}</span>
        <div className="login-page__code-row">
          <TextInput
            value={code}
            onChange={setCode}
            placeholder={t("app.login.email.codePlaceholder")}
            autoComplete="one-time-code"
            copyable={false}
            size="md"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={sending || cooldown > 0}
            onClick={() => void onSendCode()}
          >
            {cooldown > 0
              ? t("app.login.email.resendIn", { sec: cooldown })
              : sending
                ? t("app.login.email.sending")
                : t("app.login.email.sendCode")}
          </Button>
        </div>
      </label>
      <Button type="submit" variant="primary" className="login-page__submit" disabled={submitting}>
        {submitting ? t("app.login.email.submitting") : t("app.login.email.action")}
      </Button>
      {hint ? <p className="login-page__hint">{hint}</p> : null}
      {error ? <p className="login-page__hint is-error">{error}</p> : null}
    </form>
  );
}

const METHOD_OPTIONS: {
  id: LoginMethod;
  labelKey: "app.login.methods.wechat" | "app.login.methods.github" | "app.login.methods.email";
  icon?: string;
}[] = [
  { id: "wechat", labelKey: "app.login.methods.wechat", icon: wechatIcon },
  { id: "github", labelKey: "app.login.methods.github" },
  { id: "email", labelKey: "app.login.methods.email", icon: emailIcon },
];

/** 启动门禁登录页：微信扫码 / GitHub OAuth / 邮箱验证码。 */
export function LoginPage() {
  const { t } = useI18n();
  const githubIcon = useGithubIcon();
  const [method, setMethod] = useState<LoginMethod>("wechat");

  return (
    <div className="login-page" role="main" aria-label={t("app.login.title")}>
      <div className="splash__bg" aria-hidden>
        <div className="splash__grid" />
        <div className="splash__glow splash__glow--a" />
        <div className="splash__glow splash__glow--b" />
        <div className="splash__scanline" />
      </div>

      <div className="login-page__chrome" data-tauri-drag-region>
        <div className="login-page__chrome-drag" data-tauri-drag-region aria-hidden />
        <WinControls className="login-page__win-controls" />
      </div>

      <div className="login-page__content">
        <div className="login-page__brand">
          <AppLogo size={56} className="login-page__logo" />
          <h1 className="login-page__title">OmniPanel</h1>
          <p className="login-page__tagline">{t("app.tagline")}</p>
        </div>

        <div className="login-page__card">
          <h2 className="login-page__card-title">{t("app.login.title")}</h2>
          <p className="login-page__card-desc">{t("app.login.desc")}</p>

          <div className="login-page__body">
            {method === "wechat" ? <WechatLoginPanel hideHeader /> : null}
            {method === "github" ? <GithubLoginPanel /> : null}
            {method === "email" ? <EmailLoginPanel /> : null}
          </div>

          <div className="login-page__methods" role="group" aria-label={t("app.login.methodsLabel")}>
            <p className="login-page__methods-label">{t("app.login.methodsLabel")}</p>
            <div className="login-page__method-icons">
              {METHOD_OPTIONS.map((option) => {
                const label = t(option.labelKey);
                const active = method === option.id;
                const icon = option.id === "github" ? githubIcon : option.icon!;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`login-page__method-btn${active ? " is-active" : ""}`}
                    title={label}
                    aria-label={label}
                    aria-pressed={active}
                    onClick={() => setMethod(option.id)}
                  >
                    <img src={icon} alt="" width={22} height={22} aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

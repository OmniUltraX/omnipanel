import { useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { AppLogo } from "../ui/layout/AppLogo";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/form/TextInput";
import { PasswordInput } from "../ui/form/PasswordInput";
import { WechatLoginPanel } from "./WechatLoginPanel";
import { WinControls } from "../shell/WinControls";
import { useSettingsStore } from "../../stores/settingsStore";
import wechatIcon from "../../assets/icons/login/wechat.svg";
import githubDarkIcon from "../../assets/icons/login/github_dark.svg";
import githubLightIcon from "../../assets/icons/login/github_light.svg";
import emailIcon from "../../assets/icons/login/email.svg";

type LoginMethod = "wechat" | "github" | "email";

function useGithubIcon(): string {
  const resolved = useSettingsStore((s) => s.resolved);
  return resolved === "light" ? githubLightIcon : githubDarkIcon;
}

function ComingSoonHint({ children }: { children: ReactNode }) {
  return <p className="login-page__hint">{children}</p>;
}

function GithubLoginPanel() {
  const { t } = useI18n();
  const githubIcon = useGithubIcon();
  const [hint, setHint] = useState<string | null>(null);

  return (
    <div className="login-page__panel">
      <p className="login-page__panel-desc">{t("app.login.github.desc")}</p>
      <Button
        type="button"
        variant="secondary"
        className="login-page__oauth-btn"
        onClick={() => setHint(t("app.login.comingSoon"))}
      >
        <img src={githubIcon} alt="" width={16} height={16} aria-hidden />
        {t("app.login.github.action")}
      </Button>
      {hint ? <ComingSoonHint>{hint}</ComingSoonHint> : null}
    </div>
  );
}

function EmailLoginPanel() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setHint(t("app.login.comingSoon"));
  };

  return (
    <form className="login-page__panel login-page__form" onSubmit={onSubmit}>
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
        <span className="login-page__field-label">{t("app.login.email.password")}</span>
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder={t("app.login.email.passwordPlaceholder")}
          autoComplete="current-password"
          size="md"
        />
      </label>
      <Button type="submit" variant="primary" className="login-page__submit">
        {t("app.login.email.action")}
      </Button>
      {hint ? <ComingSoonHint>{hint}</ComingSoonHint> : null}
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

/** 启动门禁登录页：默认微信扫码，其余方式 UI 占位。 */
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

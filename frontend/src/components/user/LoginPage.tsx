import { useI18n } from "../../i18n";
import { AppLogo } from "../ui/layout/AppLogo";
import { WinControls } from "../shell/WinControls";
import { usesMacTrafficLights } from "../../lib/platform";
import { AuthLoginMethods } from "./AuthLoginMethods";

/** 启动门禁登录页：微信扫码 / GitHub OAuth / 邮箱验证码。 */
export function LoginPage() {
  const { t } = useI18n();
  const mac = usesMacTrafficLights();

  return (
    <div className="login-page" role="main" aria-label={t("app.login.title")}>
      <div className="splash__bg" aria-hidden>
        <div className="splash__grid" />
        <div className="splash__glow splash__glow--a" />
        <div className="splash__glow splash__glow--b" />
        <div className="splash__scanline" />
      </div>

      <div
        className={`login-page__chrome${mac ? " login-page__chrome--mac" : ""}`}
        data-tauri-drag-region
      >
        {mac ? <WinControls className="login-page__win-controls" /> : null}
        <div className="login-page__chrome-drag" data-tauri-drag-region aria-hidden />
        {!mac ? <WinControls className="login-page__win-controls" /> : null}
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
          <AuthLoginMethods />
        </div>
      </div>
    </div>
  );
}

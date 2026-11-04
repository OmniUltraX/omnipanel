import { useI18n } from "../../i18n";
import { AuthLoginMethods } from "./AuthLoginMethods";

const BENEFIT_KEYS = [
  "userCenter.guestLanding.benefits.sync",
  "userCenter.guestLanding.benefits.devices",
  "userCenter.guestLanding.benefits.profile",
] as const;

/** 未登录用户中心：左侧解锁能力说明 + 右侧登录方式。 */
export function UserCenterGuestLanding() {
  const { t } = useI18n();

  return (
    <div className="user-center-guest-landing">
      <aside className="user-center-guest-landing__benefits" aria-labelledby="user-center-guest-benefits-title">
        <h2 id="user-center-guest-benefits-title" className="user-center-guest-landing__title">
          {t("userCenter.guestLanding.title")}
        </h2>
        <ul className="user-center-guest-landing__list">
          {BENEFIT_KEYS.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        <p className="user-center-guest-landing__note">{t("userCenter.guestLanding.localNote")}</p>
      </aside>
      <div className="user-center-guest-landing__login">
        <AuthLoginMethods showTitle factsPosition="after" />
      </div>
    </div>
  );
}

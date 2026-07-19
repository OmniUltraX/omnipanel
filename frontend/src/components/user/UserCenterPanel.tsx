import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/form/TextInput";
import { Select } from "../ui/form/Select";
import {
  IconCheckCircle,
  IconMonitor,
  IconUser,
} from "../ui/icons/Icons";
import {
  LOCALE_OPTIONS,
  useSettingsStore,
  type Locale,
  type Theme,
} from "../../stores/settingsStore";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { WechatLoginPanel } from "./WechatLoginPanel";
import { UserCenterDevices } from "./UserCenterDevices";

type UserCenterSection = "account" | "subscription" | "devices";

interface NavItem {
  id: UserCenterSection;
  labelKey: "userCenter.nav.account" | "userCenter.nav.subscription" | "userCenter.nav.devices";
  icon: ReactNode;
}

export function UserCenterPanel() {
  const { t } = useI18n();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openid = useAuthStore((s) => s.openid);
  const logout = useAuthStore((s) => s.logout);
  const displayName = useUserProfileStore((s) => s.displayName);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const locale = useSettingsStore((s) => s.locale);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const closeUserCenter = useUserCenterUiStore((s) => s.closeUserCenter);

  const [activeSection, setActiveSection] = useState<UserCenterSection>("account");
  const [nameDraft, setNameDraft] = useState(displayName);

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

  const avatarLetter = useMemo(() => {
    const name = (nameDraft || displayName || t("userCenter.guest")).trim();
    return name.slice(0, 1).toUpperCase() || "?";
  }, [displayName, nameDraft, t]);

  const localeOptions = useMemo(
    () =>
      LOCALE_OPTIONS.map((item) => ({
        value: item.value,
        label: t(item.labelKey),
      })),
    [t],
  );

  const themeOptions = useMemo(
    () => [
      { value: "system", label: t("userCenter.theme.system") },
      { value: "light", label: t("userCenter.theme.light") },
      { value: "dark", label: t("userCenter.theme.dark") },
    ],
    [t],
  );

  const navItems = useMemo<NavItem[]>(
    () => [
      {
        id: "account",
        labelKey: "userCenter.nav.account",
        icon: <IconUser size={14} />,
      },
      {
        id: "subscription",
        labelKey: "userCenter.nav.subscription",
        icon: <IconCheckCircle size={14} />,
      },
      {
        id: "devices",
        labelKey: "userCenter.nav.devices",
        icon: <IconMonitor size={14} />,
      },
    ],
    [],
  );

  const commitName = () => {
    setDisplayName(nameDraft.trim());
  };

  const openFullSettings = () => {
    closeUserCenter();
    openSettings();
  };

  if (!isLoggedIn) {
    return <WechatLoginPanel />;
  }

  return (
    <div className="user-center-panel">
      <nav className="user-center-nav" aria-label={t("userCenter.title")}>
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`user-center-nav-item${activeSection === item.id ? " active" : ""}`}
            onClick={() => setActiveSection(item.id)}
          >
            {item.icon}
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      <div className="user-center-main">
        {activeSection === "account" && (
          <div className="user-center-content">
            <section className="user-center-section">
              <h3 className="user-center-section__title">{t("userCenter.profile.title")}</h3>
              <p className="user-center-section__desc">{t("userCenter.profile.desc")}</p>
              <div className="user-center-profile">
                <div className="user-center-avatar" aria-hidden>
                  {avatarLetter ? avatarLetter : <IconUser size={20} />}
                </div>
                <div className="user-center-profile__fields">
                  <label className="user-center-field">
                    <span className="user-center-field__label">{t("userCenter.profile.displayName")}</span>
                    <TextInput
                      className="input"
                      value={nameDraft}
                      onChange={setNameDraft}
                      onBlur={commitName}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitName();
                          (event.target as HTMLInputElement).blur();
                        }
                      }}
                      placeholder={t("userCenter.profile.displayNamePlaceholder")}
                    />
                  </label>
                  {openid ? (
                    <p className="user-center-openid">
                      {t("userCenter.profile.openid")}: {openid}
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="user-center-section">
              <h3 className="user-center-section__title">{t("userCenter.preferences.title")}</h3>
              <p className="user-center-section__desc">{t("userCenter.preferences.desc")}</p>
              <div className="user-center-prefs">
                <div className="user-center-pref-row">
                  <div className="user-center-pref-row__label">
                    <span>{t("userCenter.preferences.theme")}</span>
                  </div>
                  <Select
                    className="setting-select"
                    size="sm"
                    value={theme}
                    onChange={(v) => setTheme(v as Theme)}
                    searchable={false}
                    options={themeOptions}
                  />
                </div>
                <div className="user-center-pref-row">
                  <div className="user-center-pref-row__label">
                    <span>{t("userCenter.preferences.language")}</span>
                  </div>
                  <Select
                    className="setting-select"
                    size="sm"
                    value={locale}
                    onChange={(v) => setLocale(v as Locale)}
                    searchable={false}
                    options={localeOptions}
                  />
                </div>
              </div>
            </section>

            <div className="user-center-footer">
              <Button type="button" variant="ghost" size="sm" onClick={logout}>
                {t("userCenter.logout")}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={openFullSettings}>
                {t("userCenter.openSettings")}
              </Button>
            </div>
          </div>
        )}

        {activeSection === "subscription" && (
          <div className="user-center-content">
            <section className="user-center-section">
              <h3 className="user-center-section__title">{t("userCenter.plan.title")}</h3>
              <div className="user-center-plan">
                <div className="user-center-plan__badge">{t("userCenter.plan.localBadge")}</div>
                <p className="user-center-plan__text">{t("userCenter.plan.localDesc")}</p>
              </div>
            </section>
          </div>
        )}

        {activeSection === "devices" && <UserCenterDevices />}
      </div>
    </div>
  );
}

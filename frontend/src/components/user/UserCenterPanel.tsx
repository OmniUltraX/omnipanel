import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/form/TextInput";
import { Select } from "../ui/form/Select";
import { IconUser } from "../ui/icons/Icons";
import {
  LOCALE_OPTIONS,
  useSettingsStore,
  type Locale,
  type Theme,
} from "../../stores/settingsStore";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { showToast } from "../../stores/toastStore";
import {
  fetchMe,
  isAuthSessionError,
  updateProfile,
} from "../../lib/auth/loginApi";
import {
  compressImageToAvatarDataUrl,
  guessImageMime,
} from "../../lib/auth/avatarImage";
import { WechatLoginPanel } from "./WechatLoginPanel";
import { UserCenterDevices } from "./UserCenterDevices";

export function UserCenterPanel() {
  const { t } = useI18n();
  const page = useUserCenterUiStore((s) => s.page);
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const token = useAuthStore((s) => s.token);
  const openid = useAuthStore((s) => s.openid);
  const logout = useAuthStore((s) => s.logout);
  const nickname = useUserProfileStore((s) => s.nickname);
  const avatarUrl = useUserProfileStore((s) => s.avatarUrl);
  const setProfile = useUserProfileStore((s) => s.setProfile);
  const clearProfile = useUserProfileStore((s) => s.clearProfile);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const locale = useSettingsStore((s) => s.locale);
  const setLocale = useSettingsStore((s) => s.setLocale);

  const [nameDraft, setNameDraft] = useState(nickname);
  const [savingNickname, setSavingNickname] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  useEffect(() => {
    setNameDraft(nickname);
  }, [nickname]);

  useEffect(() => {
    if (!isLoggedIn || !token) return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe(token);
        if (cancelled) return;
        setProfile({
          nickname: me.nickname,
          avatarUrl: me.avatarUrl,
        });
      } catch (error) {
        if (cancelled) return;
        if (isAuthSessionError(error)) {
          clearProfile();
          logout();
          showToast(t("userCenter.profile.sessionExpired"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clearProfile, isLoggedIn, logout, setProfile, t, token]);

  const avatarLetter = useMemo(() => {
    const name = (nameDraft || nickname || t("userCenter.guest")).trim();
    return name.slice(0, 1).toUpperCase() || "?";
  }, [nameDraft, nickname, t]);

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

  const commitNickname = useCallback(async () => {
    if (!token || savingNickname) return;
    const next = nameDraft.trim();
    if (next === nickname.trim()) return;

    setSavingNickname(true);
    try {
      const me = await updateProfile(token, { nickname: next });
      setProfile({
        nickname: me.nickname,
        avatarUrl: me.avatarUrl,
      });
      setNameDraft(me.nickname);
      showToast(t("userCenter.profile.saveSuccess"));
    } catch (error) {
      setNameDraft(nickname);
      if (isAuthSessionError(error)) {
        clearProfile();
        logout();
        showToast(t("userCenter.profile.sessionExpired"));
      } else {
        showToast(
          error instanceof Error ? error.message : t("userCenter.profile.saveFailed"),
        );
      }
    } finally {
      setSavingNickname(false);
    }
  }, [clearProfile, logout, nameDraft, nickname, savingNickname, setProfile, t, token]);

  const handlePickAvatar = useCallback(async () => {
    if (!token || uploadingAvatar) return;
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        {
          name: t("userCenter.profile.avatarFilter"),
          extensions: ["png", "jpg", "jpeg", "webp", "gif"],
        },
      ],
    });
    if (!picked || Array.isArray(picked)) return;

    setUploadingAvatar(true);
    try {
      const bytes = await readFile(picked);
      const dataUrl = await compressImageToAvatarDataUrl(bytes, guessImageMime(picked));
      const me = await updateProfile(token, { avatarUrl: dataUrl });
      setProfile({
        nickname: me.nickname || nickname,
        avatarUrl: me.avatarUrl,
      });
      showToast(t("userCenter.profile.avatarSuccess"));
    } catch (error) {
      if (isAuthSessionError(error)) {
        clearProfile();
        logout();
        showToast(t("userCenter.profile.sessionExpired"));
      } else {
        showToast(
          error instanceof Error ? error.message : t("userCenter.profile.avatarFailed"),
        );
      }
    } finally {
      setUploadingAvatar(false);
    }
  }, [clearProfile, logout, nickname, setProfile, t, token, uploadingAvatar]);

  const handleLogout = () => {
    clearProfile();
    logout();
  };

  if (!isLoggedIn) {
    return <WechatLoginPanel />;
  }

  if (page === "subscription") {
    return (
      <div className="user-center-panel user-center-panel--page">
        <div className="user-center-content">
          <section className="user-center-section">
            <h3 className="user-center-section__title">{t("userCenter.plan.title")}</h3>
            <div className="user-center-plan">
              <div className="user-center-plan__badge">{t("userCenter.plan.localBadge")}</div>
              <p className="user-center-plan__text">{t("userCenter.plan.localDesc")}</p>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (page === "devices") {
    return (
      <div className="user-center-panel user-center-panel--page">
        <UserCenterDevices />
      </div>
    );
  }

  return (
    <div className="user-center-panel user-center-panel--page">
      <div className="user-center-content">
        <section className="user-center-section">
          <h3 className="user-center-section__title">{t("userCenter.profile.title")}</h3>
          <p className="user-center-section__desc">{t("userCenter.profile.desc")}</p>
          <div className="user-center-profile">
            <button
              type="button"
              className={`user-center-avatar${uploadingAvatar ? " is-busy" : ""}`}
              onClick={() => void handlePickAvatar()}
              disabled={uploadingAvatar}
              title={t("userCenter.profile.changeAvatar")}
              aria-label={t("userCenter.profile.changeAvatar")}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="user-center-avatar__img" />
              ) : (
                <span aria-hidden>{avatarLetter || <IconUser size={20} />}</span>
              )}
              <span className="user-center-avatar__hint">
                {uploadingAvatar
                  ? t("userCenter.profile.avatarUploading")
                  : t("userCenter.profile.changeAvatarShort")}
              </span>
            </button>
            <div className="user-center-profile__fields">
              <label className="user-center-field">
                <span className="user-center-field__label">{t("userCenter.profile.nickname")}</span>
                <TextInput
                  className="input"
                  value={nameDraft}
                  onChange={setNameDraft}
                  onBlur={() => void commitNickname()}
                  disabled={savingNickname}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void commitNickname();
                      (event.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={t("userCenter.profile.nicknamePlaceholder")}
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
          <Button type="button" variant="ghost" size="sm" onClick={handleLogout}>
            {t("userCenter.logout")}
          </Button>
        </div>
      </div>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useI18n } from "../../i18n";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";
import {
  selectUpdateBadgeVisible,
  useAppUpdateStore,
} from "../../stores/appUpdateStore";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import {
  resolveCurrentSyncTeamId,
  useCurrentSyncTeamStore,
} from "../../stores/currentSyncTeamStore";
import { switchSyncTeam } from "../../modules/clientSync/switchSyncTeam";
import { showToast } from "../../stores/toastStore";
import {
  IconCheckCircle,
  IconDownload,
  IconGlobe,
  IconSettings,
  IconUser,
  IconUsers,
} from "../ui/icons/Icons";
import { AppUpdateDialog } from "./AppUpdateDialog";

const WEBSITE_URL = "https://omniultrax.github.io/omnipanel/";

type MenuAction = "account" | "settings" | "website" | "update";

function isUserMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".sidebar-user-menu"));
}

function isTeamMenuNode(target: EventTarget | null): boolean {
  return Boolean(
    (target as Element | null)?.closest?.(".sidebar-team-switch-menu"),
  );
}

/** 侧栏底部：切换团队按钮（头像上方）+ 用户头像菜单。 */
export function SidebarUserButton() {
  const { t } = useI18n();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const avatarUrl = useUserProfileStore((s) => s.avatarUrl);
  const nickname = useUserProfileStore((s) => s.nickname);
  const teams = useUserProfileStore((s) => s.teams);
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);
  const userCenterOpen = useUserCenterUiStore((s) => s.open);
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const settingsOpen = useSettingsUiStore((s) => s.open);
  const updateBadge = useAppUpdateStore(selectUpdateBadgeVisible);
  const openUpdateDialog = useAppUpdateStore((s) => s.openDialog);
  const currentTeamId = useCurrentSyncTeamStore((s) => s.teamId);

  const [menuOpen, setMenuOpen] = useState(false);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [switchingTeam, setSwitchingTeam] = useState(false);
  const [switchingTeamName, setSwitchingTeamName] = useState("");
  const [style, setStyle] = useState<CSSProperties>({});
  const [teamMenuStyle, setTeamMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const teamButtonRef = useRef<HTMLButtonElement | null>(null);

  const active = userCenterOpen || settingsOpen || menuOpen;
  const effectiveTeamId = resolveCurrentSyncTeamId(currentTeamId, teams);
  const currentTeam =
    teams.find((team) => team.id === effectiveTeamId) ??
    teams.find((team) => (team.kind ?? "").trim().toLowerCase() === "personal") ??
    null;

  const updatePosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 220;
    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - menuWidth - gap);
    }
    setStyle({
      position: "fixed",
      left,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      width: menuWidth,
      zIndex: "var(--z-subwindow-popover, 1400)",
    });
  }, []);

  const updateTeamMenuPosition = useCallback(() => {
    const btn = teamButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 220;
    const maxHeight = Math.max(160, window.innerHeight - 8 - rect.top);
    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - menuWidth - gap);
    }
    setTeamMenuStyle({
      position: "fixed",
      left,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      width: menuWidth,
      maxHeight,
      zIndex: "var(--z-subwindow-popover, 1400)",
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updatePosition();
  }, [menuOpen, updatePosition]);

  useLayoutEffect(() => {
    if (!teamMenuOpen) return;
    updateTeamMenuPosition();
  }, [teamMenuOpen, updateTeamMenuPosition]);

  useEffect(() => {
    if (!menuOpen && !teamMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (teamButtonRef.current?.contains(event.target as Node)) return;
      if (isUserMenuNode(event.target) || isTeamMenuNode(event.target)) return;
      setMenuOpen(false);
      setTeamMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTeamMenuOpen(false);
        setMenuOpen(false);
      }
    };
    const onResize = () => {
      if (menuOpen) updatePosition();
      if (teamMenuOpen) updateTeamMenuPosition();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, teamMenuOpen, updatePosition, updateTeamMenuPosition]);

  const handleAction = (action: MenuAction) => {
    setMenuOpen(false);
    setTeamMenuOpen(false);
    if (action === "settings") {
      openSettings();
      return;
    }
    if (action === "website") {
      void openExternal(WEBSITE_URL);
      return;
    }
    if (action === "update") {
      openUpdateDialog();
      return;
    }
    openUserCenter("account");
  };

  const handleSelectTeam = (teamId: number) => {
    if (switchingTeam) return;
    if (effectiveTeamId === teamId) {
      setTeamMenuOpen(false);
      return;
    }
    const teamName =
      teams.find((team) => team.id === teamId)?.name?.trim() || `#${teamId}`;
    setTeamMenuOpen(false);
    setSwitchingTeamName(teamName);
    setSwitchingTeam(true);
    void (async () => {
      try {
        const result = await switchSyncTeam(teamId);
        if (!result.switched) return;
        if (result.pulledModules || result.pulledConversations) {
          showToast(t("userCenter.switchTeamSuccess", { name: teamName }));
        } else {
          showToast(t("userCenter.switchTeamEmptySnapshot", { name: teamName }));
        }
      } catch {
        showToast(t("userCenter.switchTeamFailed"));
      } finally {
        setSwitchingTeam(false);
        setSwitchingTeamName("");
      }
    })();
  };

  // 版本更新放在倒数第二（设置之前）
  const items: {
    id: MenuAction;
    label: string;
    icon: ReactNode;
    badge?: boolean;
  }[] = [
    {
      id: "account",
      label: t("userCenter.title"),
      icon: <IconUser size={14} />,
    },
    {
      id: "website",
      label: t("userCenter.nav.website"),
      icon: <IconGlobe size={14} />,
    },
    {
      id: "update",
      label: t("userCenter.update.menu"),
      icon: <IconDownload size={14} />,
      badge: updateBadge,
    },
    {
      id: "settings",
      label: t("shell.nav.settings"),
      icon: <IconSettings size={14} />,
    },
  ];

  const title = isLoggedIn
    ? nickname.trim() || t("userCenter.title")
    : t("userCenter.login.signIn");

  const teamButtonTitle = currentTeam
    ? `${t("userCenter.switchTeam")}: ${currentTeam.name || `#${currentTeam.id}`}`
    : t("userCenter.switchTeam");

  const renderTeamTag = (kind: string) => {
    const normalized = (kind ?? "").trim().toLowerCase();
    if (normalized === "personal") {
      return (
        <span className="sidebar-team-switch-menu__tag">
          {t("userCenter.switchTeamPersonal")}
        </span>
      );
    }
    return null;
  };

  return (
    <>
      {isLoggedIn ? (
        <button
          ref={teamButtonRef}
          type="button"
          className={`sidebar-item sidebar-team-switch-btn${
            teamMenuOpen || switchingTeam ? " active" : ""
          }`}
          title={teamButtonTitle}
          aria-label={t("userCenter.switchTeamAria")}
          aria-haspopup="menu"
          aria-expanded={teamMenuOpen}
          disabled={switchingTeam}
          onClick={() => {
            if (switchingTeam) return;
            setTeamMenuOpen((open) => !open);
            setMenuOpen(false);
          }}
        >
          <IconUsers size={20} />
        </button>
      ) : null}

      <button
        ref={buttonRef}
        type="button"
        className={`sidebar-item sidebar-user-btn${active ? " active" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen((open) => !open);
          setTeamMenuOpen(false);
        }}
      >
        {isLoggedIn && avatarUrl ? (
          <img src={avatarUrl} alt="" className="sidebar-user-btn__avatar" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        )}
        {updateBadge ? (
          <span className="sidebar-user-btn__badge" aria-hidden />
        ) : null}
      </button>

      {menuOpen
        ? createPortal(
            <div
              className="sidebar-user-menu"
              style={style}
              role="menu"
              aria-label={t("userCenter.menuLabel")}
            >
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="sidebar-user-menu__item"
                  onClick={() => handleAction(item.id)}
                >
                  <span className="sidebar-user-menu__icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="sidebar-user-menu__label">{item.label}</span>
                  {item.badge ? (
                    <span className="sidebar-user-menu__dot" aria-label={t("userCenter.update.badgeAria")} />
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      {teamMenuOpen
        ? createPortal(
            <div
              className="sidebar-team-switch-menu"
              style={teamMenuStyle}
              role="menu"
              aria-label={t("userCenter.switchTeamAria")}
            >
              {teams.length === 0 ? (
                <div className="sidebar-team-switch-menu__empty">
                  {t("userCenter.switchTeamEmpty")}
                </div>
              ) : (
                teams.map((team) => {
                  const isActive =
                    effectiveTeamId === team.id ||
                    (!effectiveTeamId &&
                      (team.kind ?? "").trim().toLowerCase() === "personal");
                  return (
                    <button
                      key={team.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      className={`sidebar-team-switch-menu__item${
                        isActive ? " sidebar-team-switch-menu__item--active" : ""
                      }`}
                      disabled={switchingTeam}
                      onClick={() => handleSelectTeam(team.id)}
                    >
                      <span className="sidebar-team-switch-menu__name" title={team.name}>
                        {team.name || `#${team.id}`}
                      </span>
                      {renderTeamTag(team.kind)}
                      {isActive ? (
                        <span className="sidebar-team-switch-menu__check" aria-hidden>
                          <IconCheckCircle size={14} />
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}

      {switchingTeam
        ? createPortal(
            <div
              className="sidebar-team-switch-loading"
              role="alertdialog"
              aria-busy="true"
              aria-live="assertive"
              aria-label={t("userCenter.switchTeamLoadingAria")}
            >
              <div className="sidebar-team-switch-loading__card">
                <div className="sidebar-team-switch-loading__spinner" aria-hidden />
                <p className="sidebar-team-switch-loading__title">
                  {t("userCenter.switchTeamLoading")}
                </p>
                {switchingTeamName ? (
                  <p className="sidebar-team-switch-loading__detail">
                    {t("userCenter.switchTeamLoadingDetail", {
                      name: switchingTeamName,
                    })}
                  </p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

      <AppUpdateDialog />
    </>
  );
}

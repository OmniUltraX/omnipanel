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
import { pullCloudSnapshot } from "../../modules/clientSync/pullCloudSnapshot";
import {
  IconCheckCircle,
  IconChevronRight,
  IconDownload,
  IconGlobe,
  IconSettings,
  IconUser,
  IconUsers,
} from "../ui/icons/Icons";
import { AppUpdateDialog } from "./AppUpdateDialog";

const WEBSITE_URL = "https://omniultrax.github.io/omnipanel/";

type MenuAction = "account" | "settings" | "website" | "update" | "switchTeam";

function isMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".sidebar-user-menu"));
}

/** 侧栏底部用户按钮：未登录默认图标，已登录头像；点击弹出菜单。 */
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
  const setSyncTeamId = useCurrentSyncTeamStore((s) => s.setTeamId);

  const [menuOpen, setMenuOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const [submenuStyle, setSubmenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const submenuItemRef = useRef<HTMLButtonElement | null>(null);

  const active = userCenterOpen || settingsOpen || menuOpen;

  const effectiveTeamId = resolveCurrentSyncTeamId(currentTeamId, teams);

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

  const updateSubmenuPosition = useCallback(() => {
    const item = submenuItemRef.current;
    if (!item) return;
    const rect = item.getBoundingClientRect();
    const gap = 6;
    const submenuWidth = 220;
    const maxHeight = Math.max(160, window.innerHeight - 8 - rect.top);
    let left = rect.right + gap;
    if (left + submenuWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - submenuWidth - gap);
    }
    setSubmenuStyle({
      position: "fixed",
      left,
      top: rect.top,
      width: submenuWidth,
      maxHeight,
      zIndex: "var(--z-subwindow-popover, 1400)",
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updatePosition();
  }, [menuOpen, updatePosition]);

  useLayoutEffect(() => {
    if (!submenuOpen) return;
    updateSubmenuPosition();
  }, [submenuOpen, updateSubmenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (isMenuNode(event.target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (submenuOpen) {
          setSubmenuOpen(false);
          return;
        }
        setMenuOpen(false);
      }
    };
    const onResize = () => {
      updatePosition();
      if (submenuOpen) updateSubmenuPosition();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, submenuOpen, updatePosition, updateSubmenuPosition]);

  const closeAll = useCallback(() => {
    setSubmenuOpen(false);
    setMenuOpen(false);
  }, []);

  const handleAction = (action: MenuAction) => {
    if (action === "switchTeam") {
      setSubmenuOpen((open) => !open);
      return;
    }
    closeAll();
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

  const handleSelectTeam = (teamId: number | null) => {
    setSyncTeamId(teamId);
    closeAll();
    // 切换后立即从新团队拉取快照并应用到本机
    void pullCloudSnapshot();
  };

  // 版本更新放在倒数第二（设置之前）；切换团队放在资料之后
  const items: {
    id: MenuAction;
    label: string;
    icon: ReactNode;
    badge?: boolean;
    hasSubmenu?: boolean;
  }[] = [
    {
      id: "account",
      label: t("userCenter.title"),
      icon: <IconUser size={14} />,
    },
    {
      id: "switchTeam",
      label: t("userCenter.switchTeam"),
      icon: <IconUsers size={14} />,
      hasSubmenu: true,
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

  const renderTeamTag = (kind: string) => {
    const normalized = (kind ?? "").trim().toLowerCase();
    if (normalized === "personal") {
      return (
        <span className="sidebar-user-menu__team-tag">
          {t("userCenter.switchTeamPersonal")}
        </span>
      );
    }
    return null;
  };

  return (
    <>
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
          setSubmenuOpen(false);
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
                  ref={item.hasSubmenu ? submenuItemRef : undefined}
                  type="button"
                  role="menuitem"
                  aria-haspopup={item.hasSubmenu ? "menu" : undefined}
                  aria-expanded={item.hasSubmenu ? submenuOpen : undefined}
                  className={`sidebar-user-menu__item${
                    item.hasSubmenu ? " sidebar-user-menu__item--submenu" : ""
                  }`}
                  onClick={() => handleAction(item.id)}
                  onPointerEnter={() => {
                    if (item.hasSubmenu) {
                      setSubmenuOpen(true);
                    } else {
                      setSubmenuOpen(false);
                    }
                  }}
                >
                  <span className="sidebar-user-menu__icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="sidebar-user-menu__label">{item.label}</span>
                  {item.badge ? (
                    <span className="sidebar-user-menu__dot" aria-label={t("userCenter.update.badgeAria")} />
                  ) : null}
                  {item.hasSubmenu ? (
                    <span className="sidebar-user-menu__chevron" aria-hidden>
                      <IconChevronRight size={14} />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      {menuOpen && submenuOpen
        ? createPortal(
            <div
              className="sidebar-user-menu__submenu"
              style={submenuStyle}
              role="menu"
              aria-label={t("userCenter.switchTeamAria")}
            >
              {teams.length === 0 ? (
                <div className="sidebar-user-menu__team-empty">
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
                      className={`sidebar-user-menu__team${
                        isActive ? " sidebar-user-menu__team--active" : ""
                      }`}
                      onClick={() => handleSelectTeam(team.id)}
                    >
                      <span className="sidebar-user-menu__team-name" title={team.name}>
                        {team.name || `#${team.id}`}
                      </span>
                      {renderTeamTag(team.kind)}
                      {isActive ? (
                        <span className="sidebar-user-menu__team-check" aria-hidden>
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

      <AppUpdateDialog />
    </>
  );
}

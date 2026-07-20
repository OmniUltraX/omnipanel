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
import { useI18n } from "../../i18n";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import {
  useUserCenterUiStore,
  type UserCenterPage,
} from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { IconCheckCircle, IconMonitor, IconSettings, IconUser } from "../ui/icons/Icons";

type MenuAction = UserCenterPage | "settings";

function isMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".sidebar-user-menu"));
}

/** 侧栏底部用户按钮：未登录默认图标，已登录头像；点击弹出菜单。 */
export function SidebarUserButton() {
  const { t } = useI18n();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const avatarUrl = useUserProfileStore((s) => s.avatarUrl);
  const nickname = useUserProfileStore((s) => s.nickname);
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);
  const userCenterOpen = useUserCenterUiStore((s) => s.open);
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const settingsOpen = useSettingsUiStore((s) => s.open);

  const [menuOpen, setMenuOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const active = userCenterOpen || settingsOpen || menuOpen;

  const updatePosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 200;
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

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updatePosition();
  }, [menuOpen, updatePosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (isMenuNode(event.target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onResize = () => updatePosition();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, updatePosition]);

  const handleAction = (action: MenuAction) => {
    setMenuOpen(false);
    if (action === "settings") {
      openSettings();
      return;
    }
    openUserCenter(action);
  };

  const items: { id: MenuAction; label: string; icon: ReactNode }[] = [
    {
      id: "account",
      label: t("userCenter.nav.account"),
      icon: <IconUser size={14} />,
    },
    {
      id: "subscription",
      label: t("userCenter.nav.subscription"),
      icon: <IconCheckCircle size={14} />,
    },
    {
      id: "devices",
      label: t("userCenter.nav.devices"),
      icon: <IconMonitor size={14} />,
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
        onClick={() => setMenuOpen((open) => !open)}
      >
        {isLoggedIn && avatarUrl ? (
          <img src={avatarUrl} alt="" className="sidebar-user-btn__avatar" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        )}
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
                  <span>{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

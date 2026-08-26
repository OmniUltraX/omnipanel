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
import { fetchPublicQrcodes } from "../../lib/auth/loginApi";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { IconClose, IconMonitor, IconPhone } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";

type QrKind = "miniapp" | "h5" | "feedback";
type MenuAction = "assistant" | "client";

const QR_META: Record<QrKind, { titleKey: string; altKey: string }> = {
  miniapp: {
    titleKey: "shell.miniapp.title",
    altKey: "shell.miniapp.qrAlt",
  },
  h5: {
    titleKey: "shell.miniapp.h5Title",
    altKey: "shell.miniapp.h5QrAlt",
  },
  feedback: {
    titleKey: "shell.miniapp.feedbackTitle",
    altKey: "shell.miniapp.feedbackQrAlt",
  },
};

function isMiniappMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".sidebar-miniapp-menu"));
}

/** 侧栏手机图标：弹出菜单 → 助手端二维码 / 客户端设备列表。 */
export function SidebarMiniappButton() {
  const { t } = useI18n();
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);
  const userCenterOpen = useUserCenterUiStore((s) => s.open);

  const [menuOpen, setMenuOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrKind, setQrKind] = useState<QrKind>("miniapp");
  const [miniappUrl, setMiniappUrl] = useState("");
  const [h5Url, setH5Url] = useState("");
  const [feedbackUrl, setFeedbackUrl] = useState("");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const loadQrcodes = useCallback(async () => {
    setLoadState("loading");
    try {
      const data = await fetchPublicQrcodes();
      setMiniappUrl(data.miniapp_url);
      setH5Url(data.h5_url);
      setFeedbackUrl(data.feedback_group_url);
      setLoadState("ready");
    } catch (e) {
      console.warn("[sidebarMiniapp] load qrcodes failed", e);
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadQrcodes();
  }, [loadQrcodes]);

  const updateMenuPosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 220;
    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - menuWidth - gap);
    }
    setMenuStyle({
      position: "fixed",
      left,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      width: menuWidth,
      zIndex: "var(--z-subwindow-popover, 1400)",
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (isMiniappMenuNode(event.target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onResize = () => updateMenuPosition();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, updateMenuPosition]);

  const handleMenuAction = (action: MenuAction) => {
    setMenuOpen(false);
    if (action === "assistant") {
      setQrModalOpen(true);
      if (loadState === "error" || loadState === "idle") {
        void loadQrcodes();
      }
      return;
    }
    openUserCenter("devices", { devicesClientOnly: true });
  };

  const closeQrModal = useCallback(() => setQrModalOpen(false), []);

  const qrSrc =
    qrKind === "miniapp" ? miniappUrl : qrKind === "h5" ? h5Url : feedbackUrl;
  const { titleKey, altKey } = QR_META[qrKind];

  const active = menuOpen || qrModalOpen || userCenterOpen;

  const menuItems: { id: MenuAction; label: string; icon: ReactNode }[] = [
    {
      id: "assistant",
      label: t("shell.miniapp.menuAssistant"),
      icon: <IconPhone size={14} />,
    },
    {
      id: "client",
      label: t("shell.miniapp.menuClient"),
      icon: <IconMonitor size={14} />,
    },
  ];

  const qrSwitch = (
    <div className="sidebar-miniapp-qr-switch" role="tablist" aria-label={t("shell.miniapp.switchAria")}>
      <button
        type="button"
        role="tab"
        aria-selected={qrKind === "miniapp"}
        className={`sidebar-miniapp-qr-switch__btn${qrKind === "miniapp" ? " is-active" : ""}`}
        onClick={() => setQrKind("miniapp")}
      >
        {t("shell.miniapp.tabMiniapp")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={qrKind === "h5"}
        className={`sidebar-miniapp-qr-switch__btn${qrKind === "h5" ? " is-active" : ""}`}
        onClick={() => setQrKind("h5")}
      >
        {t("shell.miniapp.tabH5")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={qrKind === "feedback"}
        className={`sidebar-miniapp-qr-switch__btn${qrKind === "feedback" ? " is-active" : ""}`}
        onClick={() => setQrKind("feedback")}
      >
        {t("shell.miniapp.tabFeedback")}
      </button>
    </div>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`sidebar-item${active ? " active" : ""}`}
        aria-label={t("shell.miniapp.menuLabel")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <IconPhone size={20} />
      </button>

      {menuOpen
        ? createPortal(
            <div
              className="sidebar-user-menu sidebar-miniapp-menu"
              style={menuStyle}
              role="menu"
              aria-label={t("shell.miniapp.menuLabel")}
            >
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="sidebar-user-menu__item"
                  onClick={() => handleMenuAction(item.id)}
                >
                  <span className="sidebar-user-menu__icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="sidebar-user-menu__label">{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      <Modal open={qrModalOpen} onClose={closeQrModal}>
        <div
          className="sidebar-miniapp-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-miniapp-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="sidebar-miniapp-dialog__header">
            <h3 id="sidebar-miniapp-title">{t(titleKey)}</h3>
            <button
              type="button"
              className="sidebar-miniapp-dialog__close"
              onClick={closeQrModal}
              aria-label={t("shell.topbar.close")}
            >
              <IconClose size={16} />
            </button>
          </div>
          {loadState === "ready" && qrSrc ? (
            <img
              className="sidebar-miniapp-dialog__qr"
              src={qrSrc}
              alt={t(altKey)}
              draggable={false}
            />
          ) : (
            <div className="sidebar-miniapp-qr-status sidebar-miniapp-qr-status--dialog">
              {loadState === "error" || (!qrSrc && loadState !== "loading" && loadState !== "idle") ? (
                <>
                  <p>{t("shell.miniapp.loadFailed")}</p>
                  <button
                    type="button"
                    className="sidebar-miniapp-qr-retry"
                    onClick={() => void loadQrcodes()}
                  >
                    {t("shell.miniapp.retry")}
                  </button>
                </>
              ) : (
                t("shell.miniapp.loading")
              )}
            </div>
          )}
          {qrSwitch}
        </div>
      </Modal>
    </>
  );
}

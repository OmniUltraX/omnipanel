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
import { appConfirm } from "../../lib/appConfirm";
import { deleteDevice, fetchDevices, fetchPublicQrcodes, type AuthDevice } from "../../lib/auth/loginApi";
import { ensureSyncTeamKey } from "../../lib/auth/syncTeamKeyApi";
import { showToast } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { IconClose, IconMonitor, IconPhone, IconGlobe } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";
import { LocalQrCode } from "../user/LocalQrCode";

type MenuAction = "assistant" | "client" | "miniapp";

function isMiniappMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".sidebar-miniapp-menu"));
}

/** 侧栏手机图标：弹出菜单 → 助手端二维码 / 客户端设备列表。 */
export function SidebarMiniappButton() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);
  const userCenterOpen = useUserCenterUiStore((s) => s.open);

  const [menuOpen, setMenuOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [miniappUrl, setMiniappUrl] = useState("");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [assistantDevices, setAssistantDevices] = useState<AuthDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [teamKeyFingerprint, setTeamKeyFingerprint] = useState("");
  const [view, setView] = useState<"list" | "qr" | "keyQr">("qr");
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const loadQrcodes = useCallback(async () => {
    setLoadState("loading");
    try {
      const data = await fetchPublicQrcodes();
      setMiniappUrl(data.miniapp_url);
      setLoadState("ready");
    } catch (e) {
      console.warn("[sidebarMiniapp] load qrcodes failed", e);
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadQrcodes();
  }, [loadQrcodes]);

  const loadAssistantDevices = useCallback(async (): Promise<AuthDevice[]> => {
    if (!token) return [];
    setDevicesLoading(true);
    try {
      const devices = await fetchDevices(token, { quiet: true });
      const assistants = devices.filter((d) => d.role === "assistant");
      setAssistantDevices(assistants);
      return assistants;
    } catch (e) {
      console.warn("[sidebarMiniapp] load assistant devices failed", e);
      setAssistantDevices([]);
      return [];
    } finally {
      setDevicesLoading(false);
    }
  }, [token]);

  const loadTeamKey = useCallback(async (): Promise<string | null> => {
    try {
      const keyResult = await ensureSyncTeamKey();
      setTeamKeyFingerprint(keyResult.fingerprint);
      return keyResult.fingerprint;
    } catch (e) {
      console.warn("[sidebarMiniapp] failed to get team key", e);
      return null;
    }
  }, []);

  const handleUnbind = useCallback(async (device: AuthDevice) => {
    if (!token) return;
    const name = device.deviceName || device.deviceId;
    const confirmed = await appConfirm(
      t("shell.miniapp.assistantUnbindConfirm", { name }),
      t("shell.miniapp.assistantUnbind"),
      { kind: "warning", confirmLabel: t("shell.miniapp.assistantUnbind") },
    );
    if (!confirmed) return;
    try {
      await deleteDevice(token, device.deviceId, device.appId);
      setAssistantDevices((prev) => prev.filter((d) => d.deviceId !== device.deviceId));
      showToast(t("shell.miniapp.assistantUnbindSuccess"));
    } catch (e) {
      console.warn("[sidebarMiniapp] unbind failed", e);
      showToast(t("shell.miniapp.assistantUnbindFailed"));
    }
  }, [token, t]);

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

  const handleMenuAction = async (action: MenuAction) => {
    setMenuOpen(false);
    if (action === "assistant") {
      if (token) {
        const assistants = await loadAssistantDevices();
        if (assistants.length > 0) {
          setView("list");
        } else {
          await loadTeamKey();
          setView("keyQr");
        }
      } else {
        await loadTeamKey();
        setView("keyQr");
      }
      setQrModalOpen(true);
      return;
    }
    if (action === "miniapp") {
      setView("qr");
      if (loadState === "error" || loadState === "idle") {
        void loadQrcodes();
      }
      setQrModalOpen(true);
      return;
    }
    openUserCenter("devices", { devicesClientOnly: true });
  };

  const closeQrModal = useCallback(() => setQrModalOpen(false), []);

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
    {
      id: "miniapp",
      label: t("shell.miniapp.menuMiniapp"),
      icon: <IconGlobe size={14} />,
    },
  ];

  const switchToQr = useCallback(() => {
    setView("qr");
    if (loadState === "error" || loadState === "idle") {
      void loadQrcodes();
    }
  }, [loadQrcodes, loadState]);

  useEffect(() => {
    if (view === "list" && assistantDevices.length === 0 && qrModalOpen) {
      void (async () => {
        await loadTeamKey();
        setView("keyQr");
      })();
    }
  }, [view, assistantDevices, qrModalOpen, loadTeamKey]);

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
                  onClick={() => void handleMenuAction(item.id)}
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
            <h3 id="sidebar-miniapp-title">
              {view === "list"
                ? t("shell.miniapp.assistantListTitle")
                : view === "keyQr"
                  ? t("shell.miniapp.teamKeyQrTitle")
                  : t("shell.miniapp.title")}
            </h3>
            <button
              type="button"
              className="sidebar-miniapp-dialog__close"
              onClick={closeQrModal}
              aria-label={t("shell.topbar.close")}
            >
              <IconClose size={16} />
            </button>
          </div>

          {view === "list" ? (
            <div className="sidebar-miniapp-assistant-list">
              {devicesLoading ? (
                <p className="sidebar-miniapp-qr-status">{t("shell.miniapp.assistantLoading")}</p>
              ) : assistantDevices.length === 0 ? (
                <p className="sidebar-miniapp-qr-status">{t("shell.miniapp.assistantListEmpty")}</p>
              ) : (
                <>
                  {assistantDevices.map((device) => (
                    <div key={device.deviceId} className="sidebar-miniapp-assistant-item">
                      <span className="sidebar-miniapp-assistant-name">
                        {device.deviceName || device.deviceId}
                      </span>
                      <button
                        type="button"
                        className="sidebar-miniapp-assistant-unbind"
                        onClick={() => void handleUnbind(device)}
                      >
                        {t("shell.miniapp.assistantUnbind")}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="sidebar-miniapp-assistant-bind-new"
                    onClick={switchToQr}
                  >
                    {t("shell.miniapp.assistantBindNew")}
                  </button>
                </>
              )}
            </div>
          ) : view === "keyQr" ? (
            <div className="sidebar-miniapp-key-qr">
              {teamKeyFingerprint ? (
                <>
                  <LocalQrCode
                    payload={`omnipanel://sync-key?fingerprint=${teamKeyFingerprint}`}
                    size={220}
                    className="sidebar-miniapp-dialog__qr"
                    alt={t("shell.miniapp.teamKeyQrAlt")}
                  />
                  <p className="sidebar-miniapp-dialog__hint">{t("shell.miniapp.teamKeyHint")}</p>
                </>
              ) : (
                <div className="sidebar-miniapp-qr-status sidebar-miniapp-qr-status--dialog">
                  {t("shell.miniapp.loading")}
                </div>
              )}
            </div>
          ) : (
            <>
              {loadState === "ready" && miniappUrl ? (
                <img
                  className="sidebar-miniapp-dialog__qr"
                  src={miniappUrl}
                  alt={t("shell.miniapp.qrAlt")}
                  draggable={false}
                />
              ) : (
                <div className="sidebar-miniapp-qr-status sidebar-miniapp-qr-status--dialog">
                  {loadState === "error" || (!miniappUrl && loadState !== "loading" && loadState !== "idle") ? (
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
              {assistantDevices.length > 0 ? (
                <button
                  type="button"
                  className="sidebar-miniapp-assistant-back"
                  onClick={() => setView("list")}
                >
                  {t("shell.miniapp.assistantBackToList")}
                </button>
              ) : null}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

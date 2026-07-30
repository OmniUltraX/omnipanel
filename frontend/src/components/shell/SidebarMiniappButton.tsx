import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import miniappQrcode from "../../assets/miniapp_qrcode.jpg";
import h5Qrcode from "../../assets/h5_qrcode.png";
import { IconClose, IconPhone } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";

const POPOVER_CLOSE_DELAY_MS = 160;

type QrKind = "miniapp" | "h5";

/** 侧栏底部小程序入口：悬停 popover 预览，点击后居中弹窗展示二维码。 */
export function SidebarMiniappButton() {
  const { t } = useI18n();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [qrKind, setQrKind] = useState<QrKind>("miniapp");
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    setPopoverOpen(false);
  }, [clearCloseTimer]);

  const closeModal = useCallback(() => setModalOpen(false), []);

  const scheduleClosePopover = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setPopoverOpen(false);
      closeTimerRef.current = null;
    }, POPOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const openPopover = useCallback(() => {
    if (modalOpen) return;
    clearCloseTimer();
    setPopoverOpen(true);
  }, [clearCloseTimer, modalOpen]);

  const updatePopoverPosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const popoverWidth = 220;
    let left = rect.right + gap;
    if (left + popoverWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - popoverWidth - gap);
    }
    setPopoverStyle({
      position: "fixed",
      left,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      width: popoverWidth,
      zIndex: "var(--z-subwindow-popover, 1400)",
    });
  }, []);

  useLayoutEffect(() => {
    if (!popoverOpen) return;
    updatePopoverPosition();
  }, [popoverOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!popoverOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover();
    };
    const onResize = () => updatePopoverPosition();
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [popoverOpen, closePopover, updatePopoverPosition]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  const handleClick = () => {
    closePopover();
    setModalOpen(true);
  };

  const active = popoverOpen || modalOpen;
  const qrSrc = qrKind === "miniapp" ? miniappQrcode : h5Qrcode;
  const titleKey =
    qrKind === "miniapp" ? "shell.miniapp.title" : "shell.miniapp.h5Title";
  const altKey =
    qrKind === "miniapp" ? "shell.miniapp.qrAlt" : "shell.miniapp.h5QrAlt";

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
    </div>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`sidebar-item${active ? " active" : ""}`}
        aria-label={t("shell.miniapp.title")}
        aria-haspopup="dialog"
        aria-expanded={active}
        onMouseEnter={openPopover}
        onMouseLeave={scheduleClosePopover}
        onFocus={openPopover}
        onBlur={scheduleClosePopover}
        onClick={handleClick}
      >
        <IconPhone size={20} />
      </button>

      {popoverOpen && !modalOpen
        ? createPortal(
            <div
              className="sidebar-miniapp-popover"
              style={popoverStyle}
              role="tooltip"
              onMouseEnter={openPopover}
              onMouseLeave={scheduleClosePopover}
            >
              <p className="sidebar-miniapp-popover__title">{t(titleKey)}</p>
              <img
                className="sidebar-miniapp-popover__qr"
                src={qrSrc}
                alt={t(altKey)}
                draggable={false}
              />
              {qrSwitch}
            </div>,
            document.body,
          )
        : null}

      <Modal open={modalOpen} onClose={closeModal}>
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
              onClick={closeModal}
              aria-label={t("shell.topbar.close")}
            >
              <IconClose size={16} />
            </button>
          </div>
          <img
            className="sidebar-miniapp-dialog__qr"
            src={qrSrc}
            alt={t(altKey)}
            draggable={false}
          />
          {qrSwitch}
        </div>
      </Modal>
    </>
  );
}

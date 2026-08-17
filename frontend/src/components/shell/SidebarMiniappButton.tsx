import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { fetchPublicQrcodes } from "../../lib/auth/loginApi";
import { IconClose, IconPhone } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";

type QrKind = "miniapp" | "h5" | "feedback";

const QR_META: Record<
  QrKind,
  { titleKey: string; altKey: string }
> = {
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

/** 侧栏底部小程序入口：点击后居中弹窗展示二维码。 */
export function SidebarMiniappButton() {
  const { t } = useI18n();
  const [modalOpen, setModalOpen] = useState(false);
  const [qrKind, setQrKind] = useState<QrKind>("miniapp");
  const [miniappUrl, setMiniappUrl] = useState("");
  const [h5Url, setH5Url] = useState("");
  const [feedbackUrl, setFeedbackUrl] = useState("");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");

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

  const closeModal = useCallback(() => setModalOpen(false), []);

  const handleClick = () => {
    setModalOpen(true);
    if (loadState === "error" || loadState === "idle") {
      void loadQrcodes();
    }
  };

  const qrSrc =
    qrKind === "miniapp" ? miniappUrl : qrKind === "h5" ? h5Url : feedbackUrl;
  const { titleKey, altKey } = QR_META[qrKind];

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
        type="button"
        className={`sidebar-item${modalOpen ? " active" : ""}`}
        aria-label={t("shell.miniapp.title")}
        aria-haspopup="dialog"
        aria-expanded={modalOpen}
        onClick={handleClick}
      >
        <IconPhone size={20} />
      </button>

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

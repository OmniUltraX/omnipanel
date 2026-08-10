import { t } from "./i18n";

/** 与桌面端 AUTH_API_BASE 一致的公开固定地址。 */
const FEEDBACK_REMOTE = "https://mp.99.protected.fun/feedback-group-qrcode.png";
const OA_FALLBACK = "./examples/gh_qrcode.jpg";
const FEEDBACK_FALLBACK = "./examples/qun_qrcode.png";

type ContactQrTab = "oa" | "feedback";

function paintActiveTab(stage: HTMLElement, tab: ContactQrTab) {
  const img = stage.querySelector<HTMLImageElement>("[data-contact-qr-img]");
  const caption = stage.querySelector<HTMLElement>("[data-contact-qr-caption]");
  const tabs = stage.querySelectorAll<HTMLButtonElement>("[data-contact-qr-tab]");

  tabs.forEach((btn) => {
    const active = btn.dataset.contactQrTab === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  if (!img || !caption) return;

  img.onerror = null;

  if (tab === "oa") {
    img.src = OA_FALLBACK;
    img.dataset.i18nAlt = "contact.oaAlt";
    img.alt = t("contact.oaAlt");
    caption.dataset.i18n = "contact.oaScan";
    caption.textContent = t("contact.oaScan");
    return;
  }

  img.src = FEEDBACK_REMOTE;
  img.dataset.i18nAlt = "contact.feedbackAlt";
  img.alt = t("contact.feedbackAlt");
  caption.dataset.i18n = "contact.feedbackScan";
  caption.textContent = t("contact.feedbackScan");
  img.onerror = () => {
    img.onerror = null;
    img.src = FEEDBACK_FALLBACK;
  };
}

export function setupContactQr() {
  const stage = document.querySelector<HTMLElement>("[data-contact-qr]");
  if (!stage) return;

  let active: ContactQrTab = "oa";
  paintActiveTab(stage, active);

  stage.querySelectorAll<HTMLButtonElement>("[data-contact-qr-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.contactQrTab;
      if (next !== "oa" && next !== "feedback") return;
      active = next;
      paintActiveTab(stage, active);
    });
  });

  document.addEventListener("omnipanel:locale", () => {
    paintActiveTab(stage, active);
  });
}

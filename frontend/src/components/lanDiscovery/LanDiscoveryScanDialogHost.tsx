import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LanDiscoveryShareOfferEvent } from "../../ipc/bindings";
import { LAN_DISCOVERY_SHARE_OFFER } from "../../ipc/events";
import { useI18n } from "../../i18n";
import { focusMainWindow, isAppInBackground } from "../../lib/appForeground";
import {
  ensureLanShareNotificationListener,
  notifyLanShareOffer,
} from "../../lib/lanShareOfferNotify";
import { safeTauriUnlisten } from "../../lib/safeTauriUnlisten";
import { showToast } from "../../stores/toastStore";
import { parseCustomPanelShareSnapshot } from "../../modules/workspace/smallComponents/customPanelShare";
import { useDashboardStore } from "../../modules/workspace/useDashboardStore";
import { IconClose } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";
import { Button } from "../ui/primitives/Button";
import { LanDiscoveryScanDialogConnected } from "./LanDiscoveryScanDialog";
import "./LanDiscoveryScanDialog.css";

type OfferState = {
  id: string;
  fromIp: string;
  label: string;
  snapshot: NonNullable<ReturnType<typeof parseCustomPanelShareSnapshot>>;
};

function makeOfferId(): string {
  return `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 挂在 AppShell：扫描弹窗 + 接收分享（前台确认框 / 后台系统通知）。 */
export function LanDiscoveryScanDialogHost() {
  const { t } = useI18n();
  const importCustomPanelFromShare = useDashboardStore(
    (s) => s.importCustomPanelFromShare,
  );
  const [offer, setOffer] = useState<OfferState | null>(null);
  const pendingRef = useRef(new Map<string, OfferState>());
  const tRef = useRef(t);
  tRef.current = t;
  const importRef = useRef(importCustomPanelFromShare);
  importRef.current = importCustomPanelFromShare;

  const acceptOffer = (state: OfferState | null) => {
    if (!state?.snapshot) return;
    pendingRef.current.delete(state.id);
    const id = importRef.current({
      label: state.snapshot.label,
      widgets: state.snapshot.widgets,
    });
    setOffer((cur) => (cur?.id === state.id ? null : cur));
    if (id) {
      showToast(tRef.current("lanDiscovery.shareAccepted", { panel: state.label }));
    }
  };

  const declineOffer = (state: OfferState | null) => {
    if (!state) return;
    pendingRef.current.delete(state.id);
    setOffer((cur) => (cur?.id === state.id ? null : cur));
  };

  const openOfferDialog = async (offerId: string) => {
    const state = pendingRef.current.get(offerId);
    if (!state) return;
    await focusMainWindow();
    setOffer(state);
  };

  useEffect(() => {
    void ensureLanShareNotificationListener({
      acceptTitle: t("lanDiscovery.shareAccept"),
      declineTitle: t("lanDiscovery.shareDecline"),
      onAccept: (offerId) => {
        const state = pendingRef.current.get(offerId) ?? null;
        void focusMainWindow().finally(() => acceptOffer(state));
      },
      onDecline: (offerId) => {
        declineOffer(pendingRef.current.get(offerId) ?? null);
      },
      onOpen: (offerId) => {
        void openOfferDialog(offerId);
      },
    });
  }, [t]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<LanDiscoveryShareOfferEvent>(LAN_DISCOVERY_SHARE_OFFER, (event) => {
      const payload = event.payload;
      if (!payload?.panelJson) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.panelJson);
      } catch {
        return;
      }
      const snapshot = parseCustomPanelShareSnapshot(parsed);
      if (!snapshot) return;

      const state: OfferState = {
        id: makeOfferId(),
        fromIp: payload.fromIp,
        label: snapshot.label,
        snapshot,
      };
      pendingRef.current.set(state.id, state);

      void (async () => {
        const background = await isAppInBackground();
        if (!background) {
          setOffer(state);
          return;
        }
        const notified = await notifyLanShareOffer({
          offerId: state.id,
          title: tRef.current("lanDiscovery.shareOfferNotifyTitle"),
          body: tRef.current("lanDiscovery.shareOfferNotifyBody", {
            panel: state.label,
            ip: state.fromIp,
          }),
          acceptTitle: tRef.current("lanDiscovery.shareAccept"),
          declineTitle: tRef.current("lanDiscovery.shareDecline"),
        });
        if (!notified) {
          await focusMainWindow();
          setOffer(state);
        }
      })();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => safeTauriUnlisten(unlisten);
  }, []);

  return (
    <>
      <LanDiscoveryScanDialogConnected />
      <Modal open={Boolean(offer)} onClose={() => declineOffer(offer)}>
        {offer ? (
          <div
            className="lan-discovery-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lan-discovery-dialog__header">
              <h3>{t("lanDiscovery.shareOfferTitle")}</h3>
              <button
                type="button"
                className="lan-discovery-dialog__close"
                onClick={() => declineOffer(offer)}
                aria-label={t("shell.topbar.close")}
              >
                <IconClose size={16} />
              </button>
            </div>
            <p className="lan-discovery-dialog__desc">
              {t("lanDiscovery.shareOfferDescription", {
                panel: offer.label,
                ip: offer.fromIp,
              })}
            </p>
            <div className="lan-discovery-dialog__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => declineOffer(offer)}
              >
                {t("lanDiscovery.shareDecline")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => acceptOffer(offer)}
              >
                {t("lanDiscovery.shareAccept")}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

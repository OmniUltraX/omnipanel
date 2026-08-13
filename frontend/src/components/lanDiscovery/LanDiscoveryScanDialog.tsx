import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type LanDiscoveryPeer } from "../../ipc/bindings";
import { LAN_DISCOVERY_PEERS } from "../../ipc/events";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { safeTauriUnlisten } from "../../lib/safeTauriUnlisten";
import { showToast } from "../../stores/toastStore";
import {
  useLanDiscoveryUiStore,
  type LanSharePayload,
} from "../../stores/lanDiscoveryUiStore";
import { buildCustomPanelShareSnapshot } from "../../modules/workspace/smallComponents/customPanelShare";
import { IconClose } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";
import { Button } from "../ui/primitives/Button";
import "./LanDiscoveryScanDialog.css";

type PeersPayload = { peers: LanDiscoveryPeer[] };

function osLabel(
  os: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const key = os.trim().toLowerCase();
  if (key === "windows") return t("lanDiscovery.os.windows");
  if (key === "macos") return t("lanDiscovery.os.macos");
  if (key === "linux") return t("lanDiscovery.os.linux");
  return os || t("lanDiscovery.os.unknown");
}

export interface LanDiscoveryScanDialogProps {
  open: boolean;
  onClose: () => void;
  sharePayload?: LanSharePayload;
}

/**
 * 局域网 OmniPanel 扫描弹窗：仅在 open 时 start_scan / 订阅 peers；关闭即 stop。
 * 若带 sharePayload（自定义面板），点击对端即发送面板快照。
 */
export function LanDiscoveryScanDialog({
  open,
  onClose,
  sharePayload = null,
}: LanDiscoveryScanDialogProps) {
  const { t } = useI18n();
  const [peers, setPeers] = useState<LanDiscoveryPeer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [responderHint, setResponderHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendingIp, setSendingIp] = useState<string | null>(null);

  const sharingPanel = sharePayload?.kind === "custom-panel";

  useEffect(() => {
    if (!open) {
      setPeers([]);
      setScanning(false);
      setResponderHint(null);
      setError(null);
      setSendingIp(null);
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const run = async () => {
      try {
        const status = await unwrapCommand(commands.lanDiscoveryStatus());
        if (cancelled) return;
        if (!status.responderOk) {
          setResponderHint(
            status.error?.trim()
              ? t("lanDiscovery.responderFailedWithReason", { reason: status.error })
              : t("lanDiscovery.responderFailed"),
          );
        } else {
          setResponderHint(null);
        }

        unlisten = await listen<PeersPayload>(LAN_DISCOVERY_PEERS, (event) => {
          setPeers(event.payload?.peers ?? []);
        });

        await unwrapCommand(commands.lanDiscoveryStartScan());
        if (cancelled) {
          await unwrapCommand(commands.lanDiscoveryStopScan()).catch(() => undefined);
          return;
        }
        setScanning(true);

        const snapshot = await unwrapCommand(commands.lanDiscoveryListPeers());
        if (!cancelled) setPeers(snapshot);
      } catch (e) {
        if (!cancelled) setError(formatIpcError(e));
      }
    };

    void run();

    return () => {
      cancelled = true;
      safeTauriUnlisten(unlisten);
      void unwrapCommand(commands.lanDiscoveryStopScan()).catch(() => undefined);
    };
  }, [open, t]);

  const handlePeerClick = async (peer: LanDiscoveryPeer) => {
    if (!sharingPanel || !sharePayload || sharePayload.kind !== "custom-panel") {
      return;
    }
    const snapshot = buildCustomPanelShareSnapshot(sharePayload.panelId);
    if (!snapshot) {
      setError(t("lanDiscovery.sharePanelMissing"));
      return;
    }
    setSendingIp(peer.ip);
    setError(null);
    try {
      await unwrapCommand(
        commands.lanDiscoverySharePanel(peer.ip, JSON.stringify(snapshot)),
      );
      showToast(
        t("lanDiscovery.shareSent", { name: peer.name, panel: sharePayload.label }),
      );
      onClose();
    } catch (e) {
      setError(formatIpcError(e));
    } finally {
      setSendingIp(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div
        className="lan-discovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lan-discovery-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="lan-discovery-dialog__header">
          <h3 id="lan-discovery-dialog-title">
            {sharingPanel ? t("lanDiscovery.shareTitle") : t("lanDiscovery.title")}
          </h3>
          <button
            type="button"
            className="lan-discovery-dialog__close"
            onClick={onClose}
            aria-label={t("shell.topbar.close")}
          >
            <IconClose size={16} />
          </button>
        </div>

        <p className="lan-discovery-dialog__desc">
          {sharingPanel && sharePayload?.kind === "custom-panel"
            ? t("lanDiscovery.shareDescription", { panel: sharePayload.label })
            : t("lanDiscovery.description")}
        </p>

        {responderHint ? (
          <p className="lan-discovery-dialog__warn">{responderHint}</p>
        ) : null}
        {error ? <p className="lan-discovery-dialog__error">{error}</p> : null}

        <div className="lan-discovery-dialog__status">
          {scanning ? (
            <span className="lan-discovery-dialog__pulse">{t("lanDiscovery.scanning")}</span>
          ) : (
            <span className="muted">{t("lanDiscovery.idle")}</span>
          )}
        </div>

        <div className="lan-discovery-dialog__list">
          {peers.length === 0 ? (
            <p className="lan-discovery-dialog__empty">{t("lanDiscovery.empty")}</p>
          ) : (
            <ul>
              {peers.map((peer) => {
                const clickable = sharingPanel;
                const busy = sendingIp === peer.ip;
                return (
                  <li key={peer.id} className="lan-discovery-dialog__item">
                    <button
                      type="button"
                      className={`lan-discovery-dialog__peer-btn${clickable ? " is-clickable" : ""}`}
                      disabled={!clickable || Boolean(sendingIp)}
                      onClick={() => void handlePeerClick(peer)}
                    >
                      <div className="lan-discovery-dialog__item-main">
                        <span className="lan-discovery-dialog__name">{peer.name}</span>
                        <span className="lan-discovery-dialog__ip">{peer.ip}</span>
                      </div>
                      <div className="lan-discovery-dialog__item-meta">
                        <span>{t("lanDiscovery.version", { version: peer.version })}</span>
                        <span>{osLabel(peer.os, t)}</span>
                        {busy ? (
                          <span>{t("lanDiscovery.shareSending")}</span>
                        ) : clickable ? (
                          <span>{t("lanDiscovery.shareToPeer")}</span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="lan-discovery-dialog__actions">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("lanDiscovery.close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 绑定 store 的弹窗宿主（分享载荷来自全局右键 / 自定义面板右键）。 */
export function LanDiscoveryScanDialogConnected() {
  const open = useLanDiscoveryUiStore((s) => s.open);
  const sharePayload = useLanDiscoveryUiStore((s) => s.sharePayload);
  const closeDialog = useLanDiscoveryUiStore((s) => s.closeDialog);
  return (
    <LanDiscoveryScanDialog
      open={open}
      onClose={closeDialog}
      sharePayload={sharePayload}
    />
  );
}

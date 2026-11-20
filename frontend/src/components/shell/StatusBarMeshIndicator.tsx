import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { commands, type MeshStatus } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { fetchDeviceIdentity, fetchDevices, type AuthDevice } from "../../lib/auth/loginApi";
import { isPersonalTeam } from "../../lib/auth/teamApi";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { useAuthStore } from "../../stores/authStore";
import {
  resolveCurrentSyncTeamId,
  useCurrentSyncTeamStore,
} from "../../stores/currentSyncTeamStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

type PeerRow = {
  id: string;
  name: string;
  self: boolean;
  ipv4: string;
  path: string;
};

function MeshPopover({
  anchorRect,
  onClose,
  spaceName,
  status,
  peers,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  spaceName: string;
  status: MeshStatus | null;
  peers: PeerRow[];
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const online = Boolean(status?.online && status.ipv4.trim());

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 300));
  const bottom = window.innerHeight - anchorRect.top + 6;
  const address = status?.ipv4.trim() || t("shell.statusbar.meshDetail.noAddress");

  return createPortal(
    <div
      ref={ref}
      className="connection-pool-popover connection-pool-popover--wide"
      style={{ left, bottom }}
      role="tooltip"
    >
      <div className="connection-pool-popover-title">{t("shell.statusbar.meshDetail.title")}</div>
      <ul className="connection-pool-popover-list">
        <li className="connection-pool-popover-row">
          <span className="connection-pool-popover-kind">{t("shell.statusbar.meshDetail.space")}</span>
          <span className="connection-pool-popover-counts">{spaceName || "—"}</span>
        </li>
        <li className="connection-pool-popover-row">
          <span className="connection-pool-popover-kind">{t("shell.statusbar.meshDetail.self")}</span>
          <span className="connection-pool-popover-counts">
            {online ? t("shell.statusbar.meshDetail.online") : t("shell.statusbar.meshDetail.offline")}
          </span>
        </li>
        <li className="connection-pool-popover-row">
          <span className="connection-pool-popover-kind">{t("shell.statusbar.meshDetail.address")}</span>
          <span className="connection-pool-popover-counts">{address}</span>
        </li>
        {peers.map((peer) => (
          <li key={peer.id} className="connection-pool-popover-row">
            <span className="connection-pool-popover-kind">
              {peer.self ? `${peer.name} · ${t("shell.statusbar.meshDetail.self")}` : peer.name}
            </span>
            <span className="connection-pool-popover-counts">
              {formatPeerAddress(peer, t)}
            </span>
          </li>
        ))}
      </ul>
      <p className="connection-pool-popover-hint">{t("shell.statusbar.meshDetail.relayHint")}</p>
    </div>,
    document.body,
  );
}

/** 状态栏组网：当前空间是否入网，悬浮列出本机地址和各设备。 */
export function StatusBarMeshIndicator() {
  const { t } = useI18n();
  const token = useAuthStore((state) => state.token);
  const teams = useUserProfileStore((state) => state.teams);
  const storedTeamId = useCurrentSyncTeamStore((state) => state.teamId);
  const teamId = resolveCurrentSyncTeamId(storedTeamId, teams);
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfId = useRef("");

  const refresh = useCallback(async () => {
    if (!isTauriRuntime() || !token?.trim() || !teamId) {
      setStatus(null);
      setPeers([]);
      return;
    }
    try {
      const next = await unwrapCommand(commands.meshStatus(teamId), { quiet: true });
      setStatus(next);
      if (!next.online) {
        setPeers([]);
        return;
      }
      try {
        const devices = await fetchDevices(token, { quiet: true });
        if (!selfId.current) {
          const identity = await fetchDeviceIdentity().catch(() => null);
          selfId.current = identity?.deviceId ?? "";
        }
        const ids = devices
          .filter((device) => device.role.trim().toLowerCase() !== "assistant")
          .map((device) => device.deviceId);
        const resolved = ids.length
          ? await unwrapCommand(commands.meshPeerIps(teamId, ids), { quiet: true })
          : [];
        const addresses = new Map(
          resolved.map((item) => [item.deviceId, { ipv4: item.ipv4, path: item.path }]),
        );
        setPeers(peerRows(devices, addresses, selfId.current));
      } catch {
        setPeers([]);
      }
    } catch {
      setStatus(null);
      setPeers([]);
    }
  }, [teamId, token]);

  useEffect(() => {
    if (!isTauriRuntime() || !token?.trim()) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [refresh, token]);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  const handleEnter = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      setOpen(true);
      void refresh();
    }, 200);
  }, [clearHoverTimer, refresh]);
  const handleLeave = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setOpen(false), 150);
  }, [clearHoverTimer]);
  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  const team = teams.find((item) => item.id === teamId);
  const spaceName = !team
    ? ""
    : isPersonalTeam(team)
      ? t("shell.statusbar.meshDetail.personal")
      : team.userTeamName.trim() || team.name;
  const online = Boolean(status?.online && status.ipv4.trim());
  const onlineCount = peers.filter((peer) => peer.ipv4.trim()).length || (online ? 1 : 0);
  const label = online
    ? t("shell.statusbar.meshDetail.chip", { count: onlineCount })
    : t("shell.statusbar.mesh");

  if (!isTauriRuntime() || !token?.trim()) return null;

  return (
    <span
      className="statusbar-hover-anchor"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        ref={anchorRef}
        type="button"
        className={`statusbar-chip ${online ? "statusbar-chip--ok" : "statusbar-chip--muted"}`}
        aria-label={label}
      >
        <span
          className={`statusbar-chip__pulse ${online ? "statusbar-chip__pulse--ok" : "statusbar-chip__pulse--off"}`}
          aria-hidden
        />
        <span className="statusbar-chip__label">{label}</span>
      </button>
      {open && anchorRef.current ? (
        <MeshPopover
          anchorRect={anchorRef.current.getBoundingClientRect()}
          onClose={() => setOpen(false)}
          spaceName={spaceName}
          status={status}
          peers={peers}
        />
      ) : null}
    </span>
  );
}

function peerRows(
  devices: AuthDevice[],
  addresses: Map<string, { ipv4: string; path: string }>,
  selfDeviceId: string,
): PeerRow[] {
  return devices
    .filter((device) => device.role.trim().toLowerCase() !== "assistant")
    .map((device) => {
      const found = addresses.get(device.deviceId);
      return {
        id: device.deviceId,
        name: device.deviceName.trim() || device.deviceId,
        self: device.deviceId === selfDeviceId,
        ipv4: found?.ipv4.trim() ?? "",
        path: found?.path ?? "",
      };
    })
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
}

function formatPeerAddress(
  peer: PeerRow,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (!peer.ipv4.trim()) return t("shell.statusbar.meshDetail.peerOffline");
  if (peer.self) return peer.ipv4;
  const path =
    peer.path === "direct"
      ? t("shell.statusbar.meshDetail.pathDirect")
      : peer.path === "relay"
        ? t("shell.statusbar.meshDetail.pathRelay")
        : t("shell.statusbar.meshDetail.pathProbing");
  return `${peer.ipv4} · ${path}`;
}

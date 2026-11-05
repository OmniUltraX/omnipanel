import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { commands, type LocalRuntimeStatus } from "../../ipc/bindings";
import {
  OMNIMCP_BUILTIN_MCP_PORT,
  OMNIMCP_BUILTIN_MCP_URL,
  resolveGatewayListenPort,
} from "../../lib/ai/localServicePorts";
import { canUseIpcBackend, isTauriRuntime } from "../../lib/isTauriRuntime";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";

type DotLevel = "ok" | "warn" | "off";

interface AiServicesHealth {
  gateway: boolean;
  mcp: boolean;
}

async function probeAi(enabled: boolean, port: number): Promise<AiServicesHealth> {
  if (canUseIpcBackend()) {
    return invoke<AiServicesHealth>("ai_services_probe", { enabled, port });
  }
  const gateway = enabled
    ? await fetch(`http://127.0.0.1:${port}/gateway/healthz`)
        .then((response) => response.ok)
        .catch(() => false)
    : false;
  const mcp = await fetch(OMNIMCP_BUILTIN_MCP_URL, { method: "GET" })
    .then(() => true)
    .catch(() => false);
  return { gateway, mcp };
}

function levelRank(level: DotLevel): number {
  if (level === "ok") return 2;
  if (level === "warn") return 1;
  return 0;
}

type ServiceRow = {
  id: string;
  name: string;
  status: string;
};

function ServicesPopover({
  anchorRect,
  onClose,
  rows,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  rows: ServiceRow[];
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 220));
  const bottom = window.innerHeight - anchorRect.top + 6;

  return createPortal(
    <div
      ref={ref}
      className="connection-pool-popover"
      style={{ left, bottom }}
      role="tooltip"
    >
      <div className="connection-pool-popover-title">
        {t("shell.statusbar.servicesDetail.title")}
      </div>
      <ul className="connection-pool-popover-list">
        {rows.map((row) => (
          <li key={row.id} className="connection-pool-popover-row">
            <span className="connection-pool-popover-kind">{row.name}</span>
            <span className="connection-pool-popover-counts">{row.status}</span>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}

/** Statusbar right: Agent Router / OmniMCP / local runtime, hover detail popover */
export function StatusBarServicesIndicator() {
  const { t } = useI18n();
  const configuredPort = useSettingsStore((s) => s.aiGatewayPort);
  const gatewayEnabled = useSettingsStore((s) => s.aiGatewayEnabled);
  const port = resolveGatewayListenPort(configuredPort);

  const [routerOk, setRouterOk] = useState(false);
  const [mcpOk, setMcpOk] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<LocalRuntimeStatus | null>(null);
  const [lmsOk, setLmsOk] = useState(false);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const checkAi = () => {
      void probeAi(gatewayEnabled, port)
        .then((health) => {
          setRouterOk(health.gateway);
          setMcpOk(health.mcp);
        })
        .catch(() => {
          setRouterOk(false);
          setMcpOk(false);
        });
    };
    checkAi();
    const timer = window.setInterval(checkAi, 15000);
    return () => window.clearInterval(timer);
  }, [gatewayEnabled, port]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const probe = commands.localRuntimeProbe;
    if (typeof probe !== "function") return;
    const check = () => {
      void probe()
        .then((res) => {
          if (res.status !== "ok") {
            setOllamaStatus(null);
            setLmsOk(false);
            return;
          }
          setOllamaStatus(res.data.ollama.status);
          setLmsOk(res.data.lmStudio.reachable);
        })
        .catch(() => {
          setOllamaStatus(null);
          setLmsOk(false);
        });
    };
    check();
    const timer = window.setInterval(check, 20000);
    return () => window.clearInterval(timer);
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const handleEnter = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setOpen(true), 200);
  }, [clearHoverTimer]);

  const handleLeave = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setOpen(false), 150);
  }, [clearHoverTimer]);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  const ollamaLevel: DotLevel =
    ollamaStatus === "running"
      ? "ok"
      : ollamaStatus === "installed_not_running"
        ? "warn"
        : lmsOk
          ? "ok"
          : "off";

  const routerLevel: DotLevel = gatewayEnabled ? (routerOk ? "ok" : "off") : "off";
  const mcpLevel: DotLevel = mcpOk ? "ok" : "off";
  const overall =
    [routerLevel, mcpLevel, ollamaLevel].sort((a, b) => levelRank(b) - levelRank(a))[0] ?? "off";

  const routerStatus = !gatewayEnabled
    ? t("shell.statusbar.servicesDetail.disabled")
    : routerOk
      ? t("shell.statusbar.servicesDetail.running")
      : t("shell.statusbar.servicesDetail.notReady");

  const mcpStatus = mcpOk
    ? t("shell.statusbar.servicesDetail.running")
    : t("shell.statusbar.servicesDetail.notReady");

  const ollamaKey = ollamaStatus ?? "not_installed";
  const rows = useMemo<ServiceRow[]>(
    () => [
      {
        id: "router",
        name: t("shell.statusbar.servicesDetail.router"),
        status: t("shell.statusbar.servicesDetail.statusWithPort", {
          status: routerStatus,
          port,
        }),
      },
      {
        id: "mcp",
        name: t("shell.statusbar.servicesDetail.mcp"),
        status: t("shell.statusbar.servicesDetail.statusWithPort", {
          status: mcpStatus,
          port: OMNIMCP_BUILTIN_MCP_PORT,
        }),
      },
      {
        id: "ollama",
        name: t("shell.statusbar.servicesDetail.ollama"),
        status: t(`settings.localModels.status.${ollamaKey}`),
      },
      {
        id: "lms",
        name: t("shell.statusbar.servicesDetail.lms"),
        status: lmsOk
          ? t("settings.localModels.lmsOnline")
          : t("settings.localModels.lmsOffline"),
      },
    ],
    [t, routerStatus, mcpStatus, port, ollamaKey, lmsOk],
  );

  const ariaLabel = useMemo(
    () => rows.map((row) => `${row.name}: ${row.status}`).join("\n"),
    [rows],
  );

  const chipTone =
    overall === "warn" ? "statusbar-chip--warn" : "statusbar-chip--muted";
  const pulseClass =
    overall === "ok"
      ? "statusbar-chip__pulse--ok"
      : overall === "warn"
        ? "statusbar-chip__pulse--warn"
        : "statusbar-chip__pulse--off";

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`statusbar-chip ${chipTone}`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        aria-label={ariaLabel}
      >
        <span className={`statusbar-chip__pulse ${pulseClass}`} aria-hidden />
        <span className="statusbar-chip__label">{t("shell.statusbar.services")}</span>
      </button>
      {open && anchorRef.current ? (
        <div onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
          <ServicesPopover
            anchorRect={anchorRef.current.getBoundingClientRect()}
            onClose={() => setOpen(false)}
            rows={rows}
          />
        </div>
      ) : null}
    </>
  );
}

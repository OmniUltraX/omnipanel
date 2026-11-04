import { useEffect, useMemo, useState } from "react";
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

/** 状态栏右侧：合并 Agent Router / OmniMCP / 本地运行时，避免一排裸圆点。 */
export function StatusBarServicesIndicator() {
  const { t } = useI18n();
  const configuredPort = useSettingsStore((s) => s.aiGatewayPort);
  const gatewayEnabled = useSettingsStore((s) => s.aiGatewayEnabled);
  const port = resolveGatewayListenPort(configuredPort);

  const [routerOk, setRouterOk] = useState(false);
  const [mcpOk, setMcpOk] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<LocalRuntimeStatus | null>(null);
  const [lmsOk, setLmsOk] = useState(false);

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

  const title = useMemo(() => {
    const ollamaKey = ollamaStatus ?? "not_installed";
    return [
      `Agent Router: ${gatewayEnabled && routerOk ? "运行中" : gatewayEnabled ? "未就绪" : "未开启"} (:${port})`,
      `OmniMCP: ${mcpOk ? "运行中" : "未就绪"} (:${OMNIMCP_BUILTIN_MCP_PORT})`,
      t("shell.statusbar.localRuntime.tooltip", {
        ollama: t(`settings.localModels.status.${ollamaKey}`),
        lms: lmsOk
          ? t("settings.localModels.lmsOnline")
          : t("settings.localModels.lmsOffline"),
      }),
    ].join("\n");
  }, [gatewayEnabled, routerOk, port, mcpOk, ollamaStatus, lmsOk, t]);

  const levelClass =
    overall === "ok"
      ? "statusbar-chip--ok"
      : overall === "warn"
        ? "statusbar-chip--warn"
        : "statusbar-chip--muted";

  return (
    <span className={`statusbar-chip ${levelClass}`} title={title} aria-label={title}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <circle cx="8" cy="8" r="2.5" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4" strokeLinecap="round" />
      </svg>
      <span className="statusbar-chip__label">{t("shell.statusbar.services")}</span>
    </span>
  );
}

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  OMNIMCP_BUILTIN_MCP_PORT,
  OMNIMCP_BUILTIN_MCP_URL,
  resolveGatewayListenPort,
} from "../../lib/ai/localServicePorts";
import { canUseIpcBackend } from "../../lib/isTauriRuntime";
import { useSettingsStore } from "../../stores/settingsStore";

interface AiServicesHealth {
  gateway: boolean;
  mcp: boolean;
}

async function probeViaTauri(enabled: boolean, port: number): Promise<AiServicesHealth> {
  return invoke<AiServicesHealth>("ai_services_probe", { enabled, port });
}

async function probeViaFetch(enabled: boolean, port: number): Promise<AiServicesHealth> {
  const gateway = enabled
    ? await fetch(`http://127.0.0.1:${port}/gateway/healthz`)
        .then((response) => response.ok)
        .catch(() => false)
    : false;

  // OmniMCP /mcp 是 POST 端点：任何响应（含 4xx/405）都说明服务在监听。
  const mcp = await fetch(OMNIMCP_BUILTIN_MCP_URL, { method: "GET" })
    .then(() => true)
    .catch(() => false);

  return { gateway, mcp };
}

/** 状态栏 Agent Router / OmniMCP 指示点 */
export function StatusBarAiServicesIndicator() {
  const configuredPort = useSettingsStore((s) => s.aiGatewayPort);
  const enabled = useSettingsStore((s) => s.aiGatewayEnabled);
  const port = resolveGatewayListenPort(configuredPort);
  const [routerOk, setRouterOk] = useState(false);
  const [mcpOk, setMcpOk] = useState(false);

  useEffect(() => {
    const check = () => {
      const probe = canUseIpcBackend()
        ? probeViaTauri(enabled, port)
        : probeViaFetch(enabled, port);

      void probe
        .then((health) => {
          setRouterOk(health.gateway);
          setMcpOk(health.mcp);
        })
        .catch(() => {
          setRouterOk(false);
          setMcpOk(false);
        });
    };
    check();
    const timer = window.setInterval(check, 15000);
    return () => window.clearInterval(timer);
  }, [enabled, port]);

  return (
    <>
      <span
        className="statusbar-dot"
        data-level={enabled && routerOk ? "ok" : "off"}
        title={`Agent Router ${enabled && routerOk ? "运行中" : "未就绪"} (:${port})`}
        aria-hidden
      />
      <span
        className="statusbar-dot"
        data-level={mcpOk ? "ok" : "off"}
        title={`OmniMCP ${mcpOk ? "运行中" : "未就绪"} (:${OMNIMCP_BUILTIN_MCP_PORT})`}
        aria-hidden
      />
    </>
  );
}

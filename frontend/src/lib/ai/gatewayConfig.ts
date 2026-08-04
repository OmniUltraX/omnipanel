import { commands } from "../../ipc/bindings";
import { isTauriRuntime } from "../isTauriRuntime";
import { useSettingsStore } from "../../stores/settingsStore";
import { resolveGatewayListenPort } from "./localServicePorts";

let lastKey = "";
let applying = false;

/** 把当前 Agent Router 设置下发到后端（仅在变更时调用，去重）。 */
async function apply(): Promise<void> {
  if (!isTauriRuntime() || applying) return;
  const s = useSettingsStore.getState();
  const listenPort = resolveGatewayListenPort(s.aiGatewayPort);
  const key = `${s.aiGatewayEnabled}|${listenPort}|${s.aiGatewayApiKey}|${s.aiGatewayBindLan}|${s.mcpExternalRequireApproval}`;
  if (key === lastKey) return;
  lastKey = key;
  applying = true;
  try {
    await commands.aiGatewayConfigure(
      s.aiGatewayEnabled,
      listenPort,
      s.aiGatewayApiKey.trim() ? s.aiGatewayApiKey.trim() : null,
      s.aiGatewayBindLan,
      s.mcpExternalRequireApproval,
    );
  } catch (err) {
    console.error("[gateway] configure failed:", err);
  } finally {
    applying = false;
  }
}

/** 启动时同步一次，并订阅设置变更自动重配 Agent Router。 */
export async function syncGatewayConfig(): Promise<void> {
  await apply();
  useSettingsStore.subscribe(() => {
    void apply();
  });
}

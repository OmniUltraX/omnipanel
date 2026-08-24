import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { PLUGIN_CONFIRM_REQUEST } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import { appConfirm } from "./appConfirm";
import { t as translate } from "../i18n";

/**
 * prod 确认请求监听：后端桥命中 env_tag=prod 目标时弹出确认框，
 * 结果经 pluginConfirmResolve 回传（60s 无响应由后端自动拒绝）。
 */
let unlisten: (() => void) | null = null;

export async function initPluginConfirmListener(): Promise<void> {
  if (unlisten) return;
  try {
    unlisten = await listen<{
      requestId: string;
      pluginId: string;
      action: string;
      target: string;
    }>(PLUGIN_CONFIRM_REQUEST, (event) => {
      void (async () => {
        const payload = event.payload;
        const confirmed = await appConfirm(
          translate("plugins.confirm.message", {
            plugin: payload.pluginId,
            action: payload.action,
            target: payload.target,
          }),
          translate("plugins.confirm.title"),
          {
            kind: "warning",
            confirmLabel: translate("plugins.confirm.allow"),
          },
        );
        await unwrapCommand(
          commands.pluginConfirmResolve(payload.requestId, confirmed),
        ).catch(() => {});
      })();
    });
  } catch {
    unlisten = null;
  }
}

/** 仅测试：重置监听。 */
export function resetPluginConfirmListenerForTests(): void {
  unlisten?.();
  unlisten = null;
}

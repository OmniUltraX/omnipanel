import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { PLUGIN_CONFIRM_REQUEST } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import { t as translate } from "../i18n";
import { ACTION_PLUGIN_HOST, pipeTarget } from "./presenceTargets";
import { requireStepUp } from "./stepUp";

/**
 * prod 确认：系统验证或打字签发 token，再回传宿主消费。
 * 插件拿不到原始 token。
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
        const token = await requireStepUp({
          action: ACTION_PLUGIN_HOST,
          target: pipeTarget(payload.pluginId, payload.action, payload.target),
          title: translate("plugins.confirm.title"),
          message: translate("plugins.confirm.message", {
            plugin: payload.pluginId,
            action: payload.action,
            target: payload.target,
          }),
          reason: payload.action,
          confirmLabel: translate("plugins.confirm.allow"),
        });
        await unwrapCommand(
          commands.pluginConfirmResolve(payload.requestId, Boolean(token), token ?? null),
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

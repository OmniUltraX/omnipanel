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
export type PluginConfirmRequestPayload = {
  requestId: string;
  pluginId: string;
  action: string;
  target: string;
};

let unlisten: (() => void) | null = null;

/** 取消、抛错、无 token 一律回传 false，保证后端 pending 不会空等到超时才拒绝。 */
export async function handlePluginConfirmRequest(
  payload: PluginConfirmRequestPayload,
): Promise<void> {
  let token: string | null = null;
  try {
    token = await requireStepUp({
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
  } catch {
    token = null;
  }
  try {
    await unwrapCommand(
      commands.pluginConfirmResolve(payload.requestId, Boolean(token), token),
    );
  } catch {
    /* 超时后 pending 已清，resolve 失败可忽略 */
  }
}

export async function initPluginConfirmListener(): Promise<void> {
  if (unlisten) return;
  try {
    unlisten = await listen<PluginConfirmRequestPayload>(
      PLUGIN_CONFIRM_REQUEST,
      (event) => {
        void handlePluginConfirmRequest(event.payload);
      },
    );
  } catch {
    unlisten = null;
  }
}

/** 仅测试：重置监听。 */
export function resetPluginConfirmListenerForTests(): void {
  unlisten?.();
  unlisten = null;
}

import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from "@tauri-apps/plugin-notification";
import { isTauriRuntime } from "./isTauriRuntime";

export const LAN_SHARE_ACTION_TYPE_ID = "lan-share-offer";
export const LAN_SHARE_ACTION_ACCEPT = "accept";
export const LAN_SHARE_ACTION_DECLINE = "decline";

const EXTRA_KIND = "lan-share-offer";

let actionsRegisteredKey: string | null = null;
let actionListenerReady: Promise<void> | null = null;
let latestHandlers: LanShareNotificationHandlers | null = null;

export type LanShareNotificationHandlers = {
  acceptTitle: string;
  declineTitle: string;
  onAccept: (offerId: string) => void;
  onDecline: (offerId: string) => void;
  /** 点击通知正文（无明确 action）时：通常唤起应用并弹出确认框 */
  onOpen: (offerId: string) => void;
};

function readOfferId(notification: NotificationOptions): string | null {
  const extra = notification.extra as Record<string, unknown> | undefined;
  if (!extra || extra.kind !== EXTRA_KIND) return null;
  const id = extra.offerId;
  return typeof id === "string" && id ? id : null;
}

async function ensurePermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  return granted;
}

async function ensureActionTypes(
  acceptTitle: string,
  declineTitle: string,
): Promise<void> {
  const key = `${acceptTitle}|${declineTitle}`;
  if (actionsRegisteredKey === key) return;
  try {
    await registerActionTypes([
      {
        id: LAN_SHARE_ACTION_TYPE_ID,
        actions: [
          {
            id: LAN_SHARE_ACTION_ACCEPT,
            title: acceptTitle,
            foreground: true,
          },
          {
            id: LAN_SHARE_ACTION_DECLINE,
            title: declineTitle,
            foreground: false,
            destructive: true,
          },
        ],
      },
    ]);
    actionsRegisteredKey = key;
  } catch (e) {
    // 桌面端部分平台不支持 action types，忽略即可
    console.warn("[lanShare] registerActionTypes failed", e);
  }
}

/** 注册通知操作监听（进程内只绑一次；handlers 可热更新）。 */
export function ensureLanShareNotificationListener(
  handlers: LanShareNotificationHandlers,
): Promise<void> {
  latestHandlers = handlers;
  if (!isTauriRuntime()) return Promise.resolve();
  if (!actionListenerReady) {
    actionListenerReady = (async () => {
      await ensureActionTypes(handlers.acceptTitle, handlers.declineTitle);
      await onAction((notification) => {
        const h = latestHandlers;
        if (!h) return;
        const offerId = readOfferId(notification);
        if (!offerId) return;
        const actionId = (notification as { actionId?: string }).actionId;
        if (actionId === LAN_SHARE_ACTION_ACCEPT) {
          h.onAccept(offerId);
          return;
        }
        if (actionId === LAN_SHARE_ACTION_DECLINE) {
          h.onDecline(offerId);
          return;
        }
        h.onOpen(offerId);
      });
    })().catch((e) => {
      console.warn("[lanShare] notification listener failed", e);
      actionListenerReady = null;
    });
  } else {
    void ensureActionTypes(handlers.acceptTitle, handlers.declineTitle);
  }
  return actionListenerReady ?? Promise.resolve();
}

export async function notifyLanShareOffer(input: {
  offerId: string;
  title: string;
  body: string;
  acceptTitle: string;
  declineTitle: string;
}): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const granted = await ensurePermission();
    if (!granted) return false;
    await ensureActionTypes(input.acceptTitle, input.declineTitle);
    sendNotification({
      title: input.title,
      body: input.body,
      actionTypeId: LAN_SHARE_ACTION_TYPE_ID,
      extra: {
        kind: EXTRA_KIND,
        offerId: input.offerId,
      },
    });
    return true;
  } catch (e) {
    console.warn("[lanShare] sendNotification failed", e);
    return false;
  }
}

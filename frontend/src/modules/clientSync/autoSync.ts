import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore } from "../../stores/aiStore";
import { buildConversationsBundle } from "./payload";
import { useClientSyncTombstoneStore } from "./tombstones";

const DEBOUNCE_MS = 4000;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
/** hydrate / applyRemote 期间禁止回推，避免回路 */
let suppressPush = false;

export function setClientConversationSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

/** 取消尚未发出的客户端会话同步（登出时调用）。 */
export function cancelClientConversationSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingAfterFlight = false;
}

/**
 * 会话变更后调度推送到 `sync/{userId}/…`（与助手快照无关）。
 */
export function scheduleClientConversationSync(options?: {
  immediate?: boolean;
}): void {
  if (suppressPush) return;

  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  if (options?.immediate) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void runPush();
    return;
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runPush();
  }, DEBOUNCE_MS);
}

async function runPush(): Promise<void> {
  if (suppressPush) return;

  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  if (inFlight) {
    pendingAfterFlight = true;
    return;
  }

  inFlight = (async () => {
    try {
      const tombstones = useClientSyncTombstoneStore.getState();
      tombstones.pruneExpired();
      const bundle = buildConversationsBundle({
        conversations: useAiStore.getState().conversations,
        deleted: tombstones.listConversationTombstones(),
      });
      await unwrapCommand(
        commands.clientSyncPushConversations({
          token,
          bodyJson: JSON.stringify(bundle),
        }),
        { quiet: true },
      );
    } catch (err) {
      console.warn("[client-sync]", formatIpcError(err));
    } finally {
      inFlight = null;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        scheduleClientConversationSync();
      }
    }
  })();

  await inFlight;
}

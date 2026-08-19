import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore } from "../../stores/aiStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { buildConversationsBundle } from "./payload";
import { useClientSyncTombstoneStore } from "./tombstones";

let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
/** hydrate / applyRemote 期间禁止回推，避免回路 */
let suppressPush = false;

export function setClientConversationSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

/** 取消尚未发出的客户端会话同步（登出时调用）。 */
export function cancelClientConversationSync(): void {
  pendingAfterFlight = false;
}

/**
 * 会话变更后立即推送到当前同步团队 OSS `ai-conversations/latest.json`。
 */
export function scheduleClientConversationSync(): void {
  if (suppressPush) return;

  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  void runPush();
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
          teamId: getCurrentSyncTeamId(),
        }),
        { quiet: true },
      );
    } catch {
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

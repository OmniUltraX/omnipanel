import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore } from "../../stores/aiStore";
import {
  scheduleClientConversationSync,
  setClientConversationSyncSuppressed,
} from "./autoSync";
import { mergeConversations, parseConversationsBundle } from "./merge";
import { useClientSyncTombstoneStore } from "./tombstones";

let hydrateInFlight: Promise<void> | null = null;

function waitPersistHydrated(store: {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (fn: () => void) => () => void;
  };
}): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = store.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

/**
 * 登录后 / 冷启动：pull 云端会话 → LWW 合并进 aiStore → 必要时回推。
 * 与助手端 inbox / 快照互不依赖。
 */
export async function hydrateClientConversationSync(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  if (hydrateInFlight) return hydrateInFlight;

  hydrateInFlight = (async () => {
    try {
      // 必须等本地会话从 IndexedDB 恢复后再 merge，否则会用空列表覆盖/误推
      await waitPersistHydrated(useAiStore);
      await waitPersistHydrated(useClientSyncTombstoneStore);

      const pulled = await unwrapCommand(
        commands.clientSyncPullConversations({ token }),
        { quiet: true },
      );

      if (!pulled.found || !pulled.bodyJson) {
        // 云端尚无数据：若本地有会话则播种
        if (useAiStore.getState().conversations.length > 0) {
          scheduleClientConversationSync({ immediate: true });
        }
        return;
      }

      const bundle = parseConversationsBundle(pulled.bodyJson);
      if (!bundle) {
        console.warn("[client-sync] 云端会话 JSON 无法解析");
        return;
      }

      const tombstoneStore = useClientSyncTombstoneStore.getState();
      tombstoneStore.mergeRemote("conversation", bundle.deleted);
      const tombstones = tombstoneStore.listConversationTombstones();

      const local = useAiStore.getState().conversations;
      const { conversations, changed } = mergeConversations({
        local,
        remote: bundle.conversations,
        tombstones,
      });

      // 复活：远端会话比 tombstone 新时清本地删除标记
      for (const c of conversations) {
        tombstoneStore.clearIfResurrected("conversation", c.id, c.updatedAt);
      }

      if (changed) {
        setClientConversationSyncSuppressed(true);
        try {
          const active = useAiStore.getState().activeConversationId;
          const activeStill = active && conversations.some((c) => c.id === active);
          useAiStore.setState({
            conversations,
            activeConversationId: activeStill
              ? active
              : conversations.find((c) => !c.parentConversationId)?.id ?? null,
          });
        } finally {
          setClientConversationSyncSuppressed(false);
        }
      }

      // 合并后回推，让对端尽快拿到本机独有会话 / tombstone
      scheduleClientConversationSync({ immediate: true });
    } catch (err) {
      console.warn("[client-sync] hydrate failed:", formatIpcError(err));
    } finally {
      hydrateInFlight = null;
    }
  })();

  return hydrateInFlight;
}

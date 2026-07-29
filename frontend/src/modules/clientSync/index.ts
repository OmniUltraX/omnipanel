export {
  scheduleClientConversationSync,
  cancelClientConversationSync,
  setClientConversationSyncSuppressed,
} from "./autoSync";
export {
  scheduleClientModuleSync,
  cancelClientModuleSync,
  hydrateClientModuleSync,
  setClientModuleSyncSuppressed,
} from "./moduleSync";
export { hydrateClientConversationSync } from "./hydrate";
export {
  recordConversationTombstones,
  recordModuleTombstones,
} from "./tombstones";
export type { ClientSyncConversationsBundle, ClientSyncTombstone } from "./types";

/** 登录 / 冷启动：会话 + 各模块一并 hydrate。 */
export async function hydrateClientSync(): Promise<void> {
  const { hydrateClientConversationSync } = await import("./hydrate");
  const { hydrateClientModuleSync } = await import("./moduleSync");
  await Promise.all([
    hydrateClientConversationSync(),
    hydrateClientModuleSync(),
  ]);
}

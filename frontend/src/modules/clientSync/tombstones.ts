/**
 * 兼容 re-export：实现已下沉到 `stores/clientSyncTombstoneStore`，
 * 切断 stores ↔ modules/clientSync 对墓碑 store 的环依赖。
 */
export {
  useClientSyncTombstoneStore,
  recordConversationTombstones,
  recordModuleTombstones,
  toIpcTombstones,
} from "../../stores/clientSyncTombstoneStore";
export type {
  ClientSyncTombstoneKind,
  ClientSyncTombstone,
} from "../../stores/clientSyncTombstoneStore";

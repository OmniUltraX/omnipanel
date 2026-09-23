/**
 * 临时开关：关闭所有云端快照/密文库拉取，避免覆盖本机已有数据。
 * 恢复自动同步时改为 `false`。
 */
export const CLOUD_PULL_DISABLED = false;

/** @deprecated 请改用 `lib/ai/chatCloudSyncFlags`；此处再导出以兼容旧 import。 */
export { AI_CHAT_CLOUD_SYNC_ENABLED } from "../../lib/ai/chatCloudSyncFlags";

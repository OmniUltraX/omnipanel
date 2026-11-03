import type { AiConversation } from "../../stores/aiStore";
import {
  CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION,
  CLIENT_SYNC_KIND_AI_CONVERSATIONS,
  type ClientSyncConversationsBundle,
  type ClientSyncTombstone,
} from "./types";

/** 单次上传不再裁剪条数。空间仓库一条会话一个文件。 */
export const CLIENT_SYNC_CONVERSATION_LIMIT = Number.POSITIVE_INFINITY;
/** 单会话保留全部消息。 */
export const CLIENT_SYNC_MESSAGE_LIMIT = Number.POSITIVE_INFINITY;

function trimConversation(conv: AiConversation): AiConversation {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  return { ...conv, messages };
}

/** 组装待上传 bundle（含 tombstone）。 */
export function buildConversationsBundle(input: {
  conversations: AiConversation[];
  deleted: ClientSyncTombstone[];
  deviceId?: string;
  now?: number;
}): ClientSyncConversationsBundle {
  const now = input.now ?? Date.now();
  const list = [...input.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const conversations = list.map(trimConversation);

  return {
    schemaVersion: CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION,
    kind: CLIENT_SYNC_KIND_AI_CONVERSATIONS,
    updatedAt: now,
    deviceId: input.deviceId,
    conversations,
    deleted: input.deleted,
  };
}

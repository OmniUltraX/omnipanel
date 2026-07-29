import type { AiConversation } from "../../stores/aiStore";
import {
  CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION,
  CLIENT_SYNC_KIND_AI_CONVERSATIONS,
  type ClientSyncConversationsBundle,
  type ClientSyncTombstone,
} from "./types";

/** 单次上传会话上限（按 updatedAt 新→旧） */
export const CLIENT_SYNC_CONVERSATION_LIMIT = 80;
/** 单会话保留的最近消息数 */
export const CLIENT_SYNC_MESSAGE_LIMIT = 120;

function trimConversation(conv: AiConversation): AiConversation {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const trimmed =
    messages.length > CLIENT_SYNC_MESSAGE_LIMIT
      ? messages.slice(messages.length - CLIENT_SYNC_MESSAGE_LIMIT)
      : messages;
  return { ...conv, messages: trimmed };
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
  const conversations = list
    .slice(0, CLIENT_SYNC_CONVERSATION_LIMIT)
    .map(trimConversation);

  return {
    schemaVersion: CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION,
    kind: CLIENT_SYNC_KIND_AI_CONVERSATIONS,
    updatedAt: now,
    deviceId: input.deviceId,
    conversations,
    deleted: input.deleted,
  };
}

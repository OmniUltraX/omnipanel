import type { AiConversation } from "../../stores/aiStore";

/** 与 Rust `CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION` 对齐 */
export const CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION = 1;

export const CLIENT_SYNC_KIND_AI_CONVERSATIONS = "ai-conversations" as const;

export interface ClientSyncTombstone {
  id: string;
  deletedAt: number;
}

/**
 * 账号级 AI 会话同步 blob。
 * 与助手端 `assistant/.../modules/assistant.json`（仅元数据）完全独立。
 */
export interface ClientSyncConversationsBundle {
  schemaVersion: number;
  kind: typeof CLIENT_SYNC_KIND_AI_CONVERSATIONS;
  updatedAt: number;
  /** 写出该 blob 的设备 id（诊断用，不参与冲突裁决） */
  deviceId?: string;
  conversations: AiConversation[];
  deleted: ClientSyncTombstone[];
}

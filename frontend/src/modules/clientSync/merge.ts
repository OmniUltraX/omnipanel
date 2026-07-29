import type { AiConversation } from "../../stores/aiStore";
import type { ClientSyncConversationsBundle, ClientSyncTombstone } from "./types";

export interface MergeConversationsInput {
  local: AiConversation[];
  remote: AiConversation[];
  /** 本地 + 远端合并后的 tombstone 表 */
  tombstones: ClientSyncTombstone[];
}

export interface MergeConversationsResult {
  conversations: AiConversation[];
  /** 是否相对 local 有实质变化（用于决定是否回推） */
  changed: boolean;
}

function tombstoneMap(list: ClientSyncTombstone[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of list) {
    const id = t.id?.trim();
    if (!id) continue;
    const at = Number(t.deletedAt) || 0;
    const prev = map.get(id) ?? 0;
    if (at > prev) map.set(id, at);
  }
  return map;
}

function normalizeConversation(raw: AiConversation): AiConversation {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return {
    ...raw,
    messages,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function fingerprint(list: AiConversation[]): string {
  return list
    .map((c) => `${c.id}:${c.updatedAt}:${c.messages?.length ?? 0}:${c.title}`)
    .sort()
    .join("|");
}

/**
 * 按会话 id 做 LWW（updatedAt）；tombstone.deletedAt 更新则视为已删。
 * 若会话 updatedAt > deletedAt，视为复活并保留。
 */
export function mergeConversations(input: MergeConversationsInput): MergeConversationsResult {
  const deleted = tombstoneMap(input.tombstones);
  const byId = new Map<string, AiConversation>();

  const consider = (raw: AiConversation) => {
    if (!raw?.id) return;
    const conv = normalizeConversation(raw);
    const deletedAt = deleted.get(conv.id) ?? 0;
    if (deletedAt > 0 && conv.updatedAt <= deletedAt) {
      return;
    }
    const prev = byId.get(conv.id);
    if (!prev || conv.updatedAt > prev.updatedAt) {
      byId.set(conv.id, conv);
      return;
    }
    if (conv.updatedAt === prev.updatedAt) {
      // 平手：保留消息更多的一侧
      if ((conv.messages?.length ?? 0) > (prev.messages?.length ?? 0)) {
        byId.set(conv.id, conv);
      }
    }
  };

  for (const c of input.local) consider(c);
  for (const c of input.remote) consider(c);

  const conversations = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const changed = fingerprint(conversations) !== fingerprint(input.local);
  return { conversations, changed };
}

export function parseConversationsBundle(
  bodyJson: string,
): ClientSyncConversationsBundle | null {
  try {
    const raw = JSON.parse(bodyJson) as Partial<ClientSyncConversationsBundle>;
    if (!raw || typeof raw !== "object") return null;
    const schemaVersion = Number(raw.schemaVersion) || 0;
    if (schemaVersion < 1) return null;
    return {
      schemaVersion,
      kind: "ai-conversations",
      updatedAt: Number(raw.updatedAt) || 0,
      deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
      conversations: Array.isArray(raw.conversations)
        ? (raw.conversations as AiConversation[])
        : [],
      deleted: Array.isArray(raw.deleted) ? (raw.deleted as ClientSyncTombstone[]) : [],
    };
  } catch {
    return null;
  }
}

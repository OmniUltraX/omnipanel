import { useSettingsStore } from "../../stores/settingsStore";
import { commandApprovalKeys } from "./terminalCommandFingerprint";

export type CommandWhitelistScope = {
  /** 当前 AI 会话（优先） */
  conversationId?: string | null;
  /** 当前终端会话（无 AI 会话时，或与 AI 会话一并绑定） */
  terminalSessionId?: string | null;
};

/** 会话白名单：按 AI 会话 / 终端会话隔离，切换会话即失效 */
const sessionWhitelists = new Map<string, Set<string>>();

function scopeIds(scope?: CommandWhitelistScope | null): string[] {
  if (!scope) return [];
  const ids: string[] = [];
  const conv = scope.conversationId?.trim();
  if (conv) ids.push(`ai:${conv}`);
  const term = scope.terminalSessionId?.trim();
  if (term) ids.push(`term:${term}`);
  return ids;
}

/** 按钮展示用：取主命令类型（如 du / docker restart） */
export function formatCommandWhitelistLabel(command: string): string {
  const keys = commandApprovalKeys(command);
  if (keys.length > 0) return keys[0]!;
  const fallback = command.trim().split(/\s+/)[0];
  return fallback || command.trim();
}

export function clearSessionCommandWhitelist(scope?: CommandWhitelistScope | string): void {
  if (scope == null) {
    sessionWhitelists.clear();
    return;
  }
  if (typeof scope === "string") {
    sessionWhitelists.delete(scope);
    return;
  }
  for (const id of scopeIds(scope)) {
    sessionWhitelists.delete(id);
  }
}

export function addSessionCommandWhitelist(
  command: string,
  scope: CommandWhitelistScope,
): string[] {
  const keys = commandApprovalKeys(command);
  const ids = scopeIds(scope);
  if (keys.length === 0 || ids.length === 0) return [];
  for (const id of ids) {
    let set = sessionWhitelists.get(id);
    if (!set) {
      set = new Set();
      sessionWhitelists.set(id, set);
    }
    for (const key of keys) set.add(key);
  }
  return keys;
}

export function addPermanentCommandWhitelist(command: string): string[] {
  const keys = commandApprovalKeys(command);
  if (keys.length === 0) return keys;
  const store = useSettingsStore.getState();
  const prev = store.terminalCommandWhitelist ?? [];
  const next = [...prev];
  for (const key of keys) {
    if (!next.includes(key)) next.push(key);
  }
  store.setTerminalCommandWhitelist(next);
  return keys;
}

export function isCommandWhitelisted(
  command: string,
  scope?: CommandWhitelistScope | null,
): boolean {
  const keys = commandApprovalKeys(command);
  if (keys.length === 0) return false;
  const permanent = useSettingsStore.getState().terminalCommandWhitelist ?? [];
  const permanentSet = new Set(permanent);
  const ids = scopeIds(scope);

  return keys.every((key) => {
    if (permanentSet.has(key)) return true;
    return ids.some((id) => sessionWhitelists.get(id)?.has(key));
  });
}

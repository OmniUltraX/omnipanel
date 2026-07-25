import type { TerminalSession } from "../../stores/terminalStore";
import { resolveResourceById, useConnectionStore } from "../../stores/connectionStore";
import { SEED_RESOURCES } from "../../lib/resourceRegistry";
import { resolveTerminalTabBaseTitle } from "./terminalSessionDisplay";

const DEFAULT_SHELL_TITLES = new Set(
  [
    "powershell",
    "pwsh",
    "bash",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "shell",
    "ssh",
    "wsl",
    "nushell",
    "nu",
  ].map((s) => s.toLowerCase()),
);

export function isBuiltinDefaultTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (trimmed === "本地终端" || trimmed === "Local Terminal") return true;
  if (DEFAULT_SHELL_TITLES.has(trimmed.toLowerCase())) return true;
  if (/^[^\s]+@[^\s]+$/.test(trimmed)) return true;
  return false;
}

function titleEqualsAnyKnownResourceName(title: string): boolean {
  // 顶栏「+」曾用当前工作区资源名创建本地会话：标题可能是其它连接名，仍视为未手动命名
  for (const conn of useConnectionStore.getState().connections) {
    if (conn.name.trim() === title) return true;
  }
  for (const seed of SEED_RESOURCES) {
    if (seed.name.trim() === title) return true;
  }
  return false;
}

/** 判断标题是否仍为默认值（未被用户修改过） */
export function isDefaultSessionTitle(
  session: Pick<TerminalSession, "title" | "session">,
): boolean {
  const title = session.title.trim();
  if (isBuiltinDefaultTitle(title)) return true;

  const resource = resolveResourceById(session.session.resourceId);
  const resourceName = resource?.name?.trim() ?? "";
  const shellLabel = session.session.shellLabel?.trim() ?? "";

  if (resourceName && title === resourceName) return true;

  if (titleEqualsAnyKnownResourceName(title)) return true;

  const baseTitle = resolveTerminalTabBaseTitle(
    session.session.resourceId,
    null,
    resourceName || null,
    shellLabel || null,
  );
  if (title === baseTitle) return true;

  if (resourceName) {
    const prefixed = `${resourceName}-${baseTitle}`;
    if (title === prefixed) return true;
    if (title.startsWith(`${resourceName}-`)) {
      const suffix = title.slice(resourceName.length + 1);
      if (isBuiltinDefaultTitle(suffix)) return true;
    }
  }

  return false;
}

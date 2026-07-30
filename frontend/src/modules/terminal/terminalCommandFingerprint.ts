const COMPOUND_VERBS = new Set([
  "docker",
  "kubectl",
  "k",
  "git",
  "systemctl",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "apt",
  "apt-get",
  "brew",
]);

/** 剥离 fd 复制与丢弃到 /dev/null 的重定向，避免误判为写操作 */
export function stripHarmlessRedirects(command: string): string {
  return command
    .replace(/(?:^|[\s;|&])(?:\d*>&\d+|\d*>\s*\/dev\/null|&>\s*\/dev\/null)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingShellModifiers(segment: string): string {
  let rest = segment.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = rest
      .replace(/^(?:sudo|time|nohup|command)\s+/i, "")
      .replace(/^env\s+(?:\S+=\S+\s+)*/i, "")
      .trim();
    if (next === rest) break;
    rest = next;
  }
  return rest;
}

/** 按 && / || / ; / | 拆段（\|\| 须排在 \| 前） */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\|)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function segmentTokens(segment: string): string[] {
  const normalized = stripLeadingShellModifiers(stripHarmlessRedirects(segment));
  if (!normalized) return [];
  return normalized.split(/\s+/);
}

/** 审批白名单键：动词，或 docker/git 等「动词 + 子命令」 */
export function commandApprovalKey(segment: string): string {
  const tokens = segmentTokens(segment);
  const verb = tokens[0]?.toLowerCase() ?? "";
  if (!verb) return "";
  if (COMPOUND_VERBS.has(verb)) {
    const sub = tokens[1]?.toLowerCase();
    return sub ? `${verb} ${sub}` : verb;
  }
  return verb;
}

export function commandApprovalKeys(command: string): string[] {
  const trimmed = stripHarmlessRedirects(command.trim());
  if (!trimmed) return [];
  const keys = splitCommandSegments(trimmed)
    .map((segment) => commandApprovalKey(segment))
    .filter(Boolean);
  return [...new Set(keys)];
}

import type { Connection } from "../ipc/bindings";

/** OpenSSH 配置导入主机的分组标识（展示文案走 i18n）。 */
export const OPENSSH_CONFIG_GROUP = "~/.ssh/config";

const GROUP_ORDER = ["默认", OPENSSH_CONFIG_GROUP];

const MANUAL_GROUPS_STORAGE_KEY = "omnipanel.ssh.manualGroups.v1";

/** 从 localStorage 读取手动新建的空分组列表。 */
export function loadManualEmptyGroups(): string[] {
  try {
    const raw = localStorage.getItem(MANUAL_GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

/** 保存手动新建的空分组列表到 localStorage。 */
export function saveManualEmptyGroups(groups: string[]): void {
  try {
    const normalized = Array.from(new Set(groups.map(normalizeSshGroup).filter(Boolean)));
    localStorage.setItem(MANUAL_GROUPS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* ignore */
  }
}

/**
 * 合并连接推导出的分组与手动空分组，返回去重后的完整分组名列表（已排序）。
 * 当某个手动分组已存在真实连接时，自动从手动列表中剔除（转正）。
 */
export function mergeGroupsWithManual(
  fromConnections: string[],
  manualGroups: string[],
): { groups: string[]; staleManual: string[] } {
  const connSet = new Set(fromConnections);
  const staleManual: string[] = [];
  const merged = new Set(fromConnections);
  for (const g of manualGroups) {
    const norm = normalizeSshGroup(g);
    if (connSet.has(norm)) {
      // 已被真实连接占用，标记为需要从手动列表移除
      staleManual.push(g);
      continue;
    }
    merged.add(norm);
  }
  return { groups: sortSshGroups([...merged]), staleManual };
}

/** 从已有 SSH 连接收集分组名（用于输入建议，含当前值）。 */
export function collectSshGroupSuggestions(
  connections: Connection[],
  currentGroup?: string,
): string[] {
  const set = new Set<string>();
  for (const conn of connections) {
    if (conn.kind !== "ssh") continue;
    set.add(normalizeSshGroup(conn.group));
  }
  const normalized = normalizeSshGroup(currentGroup);
  if (normalized) set.add(normalized);
  return sortSshGroups([...set]);
}

/** 保存前规范化用户输入的分组名。 */
export function sanitizeSshGroupInput(group: string): string {
  return normalizeSshGroup(group);
}

/** 规范化连接分组名（空 / default → 默认）。 */
export function normalizeSshGroup(group?: string | null): string {
  const trimmed = group?.trim();
  if (!trimmed || trimmed === "default") return "默认";
  return trimmed;
}

/** 分组标题展示（OpenSSH 分组走翻译）。 */
export function sshGroupLabel(group: string, t: (key: string) => string): string {
  if (group === OPENSSH_CONFIG_GROUP) {
    return t("ssh.sidebar.openSshGroup");
  }
  return group;
}

/** 分组排序：预设顺序优先，其余按 locale 排序。 */
export function sortSshGroups(groups: string[]): string[] {
  return [...groups].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a.localeCompare(b, "zh-CN");
  });
}

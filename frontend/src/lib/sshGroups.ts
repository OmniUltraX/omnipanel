import type { Connection } from "../ipc/bindings";

/** OpenSSH 配置导入主机的分组标识（展示文案走 i18n）。 */
export const OPENSSH_CONFIG_GROUP = "~/.ssh/config";

const GROUP_ORDER = ["默认", OPENSSH_CONFIG_GROUP];

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

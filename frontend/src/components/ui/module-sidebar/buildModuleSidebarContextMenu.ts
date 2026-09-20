import type { ContextMenuItem } from "../menu";

export type ModuleSidebarMenuSections = {
  /** 打开：预览 / 常驻（置顶段） */
  open?: ContextMenuItem[];
  /** 新建类：新建分组 / 文档 / 会话 / 连接 */
  create?: ContextMenuItem[];
  /** 标签：资源标签管理 */
  tags?: ContextMenuItem[];
  /** 编辑：重命名 / 复制 */
  edit?: ContextMenuItem[];
  /** 危险：删除（末段，调用方标 danger） */
  danger?: ContextMenuItem[];
};

let menuSeparatorSerial = 0;

function separator(): ContextMenuItem {
  menuSeparatorSerial += 1;
  return { id: `module-sidebar-sep-${menuSeparatorSerial}`, separator: true, label: "" };
}

/**
 * 侧栏树右键段落模板：打开 → 新建类 → 标签 → 编辑 → 危险。
 *
 * 各模块只填自有项（终端"移到工作区"、知识库"向量化/分享"、SSH"跳转"），
 * 不再自排分隔线顺序；空段自动跳过，分隔线只出现在非空段之间。
 */
export function buildModuleSidebarContextMenu(
  sections: ModuleSidebarMenuSections,
): ContextMenuItem[] {
  const groups = [
    sections.open ?? [],
    sections.create ?? [],
    sections.tags ?? [],
    sections.edit ?? [],
    sections.danger ?? [],
  ].filter((group) => group.length > 0);

  const items: ContextMenuItem[] = [];
  for (const group of groups) {
    if (items.length > 0) items.push(separator());
    items.push(...group);
  }
  return items;
}

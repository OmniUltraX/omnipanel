import type { ReactNode } from "react";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "../sidebar/VerticalSplitSidebar";
import { SidebarCountBadge } from "./SidebarCountBadge";

export type ModuleSidebarSectionProps = VerticalSplitSidebarSectionConfig & {
  /** 段内叶子总数：渲染在操作区末尾，保证各模块段头布局一致 */
  count?: number | string | null;
  countTitle?: string;
  /** 段头通用工具条（一键折叠 / 展开 / 刷新），放在自定义 actions 之后、计数之前 */
  toolbar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  keepMounted?: boolean;
  bodyHeightPx?: number;
  onBodyHeightChange?: (heightPx: number) => void;
  minBodyHeightPx?: number;
  maxBodyHeightPx?: number;
  resizePlacement?: "top" | "bottom";
};

/**
 * L1 分段标准壳：`VerticalSplitSidebarSection` 的薄封装，只收敛 actions 槽位。
 *
 * 槽位顺序固定：计数徽标（标题按钮内、标题文字右侧）→ 自定义 actions → toolbar。
 * 按钮全部靠右，计数紧跟标题。
 * 单分组原则：哪怕模块只有一个分组，也必须包一层本组件，不允许裸树直挂。
 */
export function ModuleSidebarSection({
  count,
  countTitle,
  toolbar,
  actions,
  children,
  ...section
}: ModuleSidebarSectionProps) {
  return (
    <VerticalSplitSidebarSection
      {...section}
      badge={
        count != null ? <SidebarCountBadge count={count} title={countTitle} /> : undefined
      }
      actions={
        actions || toolbar ? (
          <>
            {actions}
            {toolbar}
          </>
        ) : undefined
      }
    >
      {children}
    </VerticalSplitSidebarSection>
  );
}

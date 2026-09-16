import type { DbConnectionConfig } from "../api";
import type { ToolboxTabId } from "./types";

export interface DatabaseToolboxProps {
  connections: DbConnectionConfig[];
  /** 数据同步 / 结构同步（由 Dock Tab 绑定任务类型决定） */
  tab: ToolboxTabId;
  /** 绑定的同步任务；每个 Dock Panel 对应一个任务 */
  syncTaskId: string;
  /** 打开工具箱时默认源库连接 */
  initialSourceConnectionId?: string | null;
  initialSourceDatabase?: string;
  /** 为 false 时不发起任何库连接请求（分段 Tab 未激活时由父级传入） */
  active?: boolean;
}

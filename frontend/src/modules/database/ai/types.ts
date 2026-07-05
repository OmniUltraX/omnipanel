/** 供 AI 使用的连接摘要（不含密码等敏感字段） */
export interface DatabaseConnectionContext {
  id: string;
  name: string;
  dbType: string;
  host: string;
  port: number;
  user: string;
  /** 连接配置中的默认库 */
  defaultDatabase: string;
  ssl: boolean;
  status: string;
  enabled: boolean;
}

/** 数据库模块 AI 上下文：仅到「连接 + 库」层级，不含表及以下节点 */
export interface DatabaseModuleContext {
  connection: DatabaseConnectionContext | null;
  /** 当前选中的数据库名；仅选中连接时为空 */
  database: string | null;
}

export function isDatabaseModuleContextEmpty(
  context: DatabaseModuleContext,
): boolean {
  return context.connection == null && !context.database;
}

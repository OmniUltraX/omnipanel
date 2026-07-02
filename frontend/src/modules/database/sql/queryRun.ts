/** 生成 SQL 查询 runId，与后端 db_execute_query / db_cancel_query 配对。 */
export function makeQueryRunId(): string {
  return `query:${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function isQueryCancelledError(error: unknown): boolean {
  const message = typeof error === "string" ? error : JSON.stringify(error);
  return message.includes("查询已中断") || message.includes("cancelled");
}

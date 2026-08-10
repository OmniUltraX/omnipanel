/**
 * IPC / 软降级结果的安全数组转换，避免对非数组调用 .map/.filter。
 * 默认元素类型为 any，便于承接 unwrap 后的运行时形状兜底。
 */
export function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * 统一错误字符串化工具。
 *
 * 核心问题：Tauri 后端命令返回 `Result<T, OmniError>`，失败时前端 `invoke`
 * throw 的是 OmniError 的 JSON 反序列化对象（`{code, message, cause?}`），
 * 不是 `Error` 实例。直接 `String(obj)` 会得到 `"[object Object]"`，丢失
 * `message` 字段中的可读错误信息。
 *
 * 本函数按优先级提取可读信息：
 * 1. `Error` 实例 → `err.message`（含 stack 截断保护）
 * 2. 有 `message` 字段的对象（OmniError / 自定义错误）→ `obj.message` + cause
 * 3. 字符串 → 直接返回
 * 4. 其他 → `JSON.stringify`，失败再回退 `String()`
 */
export function errorToString(err: unknown): string {
  // Error 实例
  if (err instanceof Error) {
    return err.message;
  }

  // 字符串
  if (typeof err === "string") {
    return err;
  }

  // 对象：尝试提取 message + cause（OmniError 格式）
  if (err !== null && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const message =
      typeof obj.message === "string" ? obj.message : "";
    const cause =
      typeof obj.cause === "string" ? obj.cause : "";
    if (message && cause) {
      return `${message}（原因：${cause}）`;
    }
    if (message) {
      return message;
    }
    // 无 message 字段，尝试 JSON 序列化
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  // number / boolean / undefined / null
  return String(err);
}

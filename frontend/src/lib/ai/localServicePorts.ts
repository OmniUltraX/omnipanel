/** 与 Rust `omnipanel_gateway` / `omnipanel_mcp` 端口约定保持一致。 */

export const RELEASE_GATEWAY_PORT = 8765;
export const DEV_GATEWAY_PORT = 8766;
export const RELEASE_OMNIMCP_PORT = 12756;
export const DEV_OMNIMCP_PORT = 12757;

export const DEFAULT_GATEWAY_PORT = import.meta.env.DEV
  ? DEV_GATEWAY_PORT
  : RELEASE_GATEWAY_PORT;

export const OMNIMCP_BUILTIN_MCP_PORT = import.meta.env.DEV
  ? DEV_OMNIMCP_PORT
  : RELEASE_OMNIMCP_PORT;

export const OMNIMCP_BUILTIN_MCP_URL = `http://127.0.0.1:${OMNIMCP_BUILTIN_MCP_PORT}/mcp`;

/**
 * 解析 Agent Router 实际监听端口。
 * 开发态若设置里仍是正式版默认 8765（共享 ~/.omnipd），自动错开到 8766。
 */
export function resolveGatewayListenPort(configured: number): number {
  const port = configured || DEFAULT_GATEWAY_PORT;
  if (import.meta.env.DEV && port === RELEASE_GATEWAY_PORT) {
    return DEV_GATEWAY_PORT;
  }
  return port;
}

/** 是否为当前构建（或正式版）的内置 OmniMCP URL。 */
export function isBuiltinOmniMcpUrl(url: string | undefined): boolean {
  if (!url) return false;
  const normalized = url.replace(/\/$/, "");
  const candidates = [
    OMNIMCP_BUILTIN_MCP_URL,
    `http://127.0.0.1:${RELEASE_OMNIMCP_PORT}/mcp`,
    `http://127.0.0.1:${DEV_OMNIMCP_PORT}/mcp`,
  ].map((u) => u.replace(/\/$/, ""));
  return candidates.includes(normalized);
}

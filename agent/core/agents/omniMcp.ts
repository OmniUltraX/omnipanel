import type { McpServer } from "@agentclientprotocol/sdk";

/** 内置 OmniMCP HTTP 端点（与 crates/omnipanel-mcp BUILTIN_MCP_ENDPOINT 一致）。 */
export const OMNI_MCP_URL = "http://127.0.0.1:12756/mcp";

export const OMNI_MCP_MODULE_HEADER = "X-Omni-Module";

/** 为指定模块创建 OmniMCP HTTP 连接（通过请求头过滤工具列表）。 */
export function createOmniMcpServers(
  moduleKey: string,
  serviceName = "OmniMCP",
): McpServer[] {
  return [
    {
      type: "http",
      name: serviceName,
      url: OMNI_MCP_URL,
      headers: [{ name: OMNI_MCP_MODULE_HEADER, value: moduleKey }],
    },
  ];
}

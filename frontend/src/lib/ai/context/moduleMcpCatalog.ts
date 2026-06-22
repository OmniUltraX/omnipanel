import type { ModuleKey } from "../../paths";
import type { McpToolInfo } from "../../ipc/bindings";
import { DATABASE_MODULE_MCP_TOOLS } from "../../../modules/database/ai/mcpTools";
import type { McpToolRegistration } from "./types";

/** 与 Rust `BUILTIN_SERVICE_ID` 保持一致 */
export const OMNIMCP_BUILTIN_SERVICE_ID = "omnimcp-builtin";

const MODULE_MCP_CATALOG: Partial<Record<ModuleKey, McpToolRegistration[]>> = {
  database: DATABASE_MODULE_MCP_TOOLS,
};

export function getModuleMcpToolsFromCatalog(moduleKey: ModuleKey): McpToolRegistration[] {
  return MODULE_MCP_CATALOG[moduleKey] ?? [];
}

/** 供设置页 OmniMCP 工具列表合并展示 */
export function getAllModuleMcpToolInfos(): McpToolInfo[] {
  const items: McpToolInfo[] = [];
  for (const [moduleKey, tools] of Object.entries(MODULE_MCP_CATALOG) as [
    ModuleKey,
    McpToolRegistration[],
  ][]) {
    for (const tool of tools) {
      items.push({
        name: tool.name,
        description: tool.description
          ? `[${moduleKey}] ${tool.description}`
          : `[${moduleKey}]`,
      });
    }
  }
  return items;
}

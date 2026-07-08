import type { ModuleKey } from "../../paths";
import type { BuiltinToolCatalogEntry, ToolInfo } from "../../../ipc/bindings";
import { DATABASE_MODULE_TOOLS } from "../../../modules/database/ai/mcpTools";
import { TERMINAL_MODULE_TOOLS } from "../../../modules/terminal/ai/mcpTools";
import { KNOWLEDGE_MODULE_TOOLS } from "../../../modules/knowledge/ai/mcpTools";
import type { BuiltinToolRegistration } from "./types";

/** 与 Rust `BUILTIN_SERVICE_ID` 保持一致 */
export const OMNIMCP_BUILTIN_SERVICE_ID = "omnimcp-builtin";
/** 内置 OmniMCP HTTP 固定端口，与 Rust `BUILTIN_MCP_PORT` 一致 */
export const OMNIMCP_BUILTIN_MCP_PORT = 12756;
export const OMNIMCP_BUILTIN_MCP_URL = `http://127.0.0.1:${OMNIMCP_BUILTIN_MCP_PORT}/mcp`;

const MODULE_BUILTIN_CATALOG: Partial<Record<ModuleKey, BuiltinToolRegistration[]>> = {
  database: DATABASE_MODULE_TOOLS,
  terminal: TERMINAL_MODULE_TOOLS,
};

/** Rust 内置 knowledge 工具（与 omnipanel-store BUILTIN_TOOL_SPECS 对齐） */
const KNOWLEDGE_BUILTIN_CATALOG: BuiltinToolRegistration[] = [
  {
    name: "omni_knowledge_create_document",
    description: "在知识库中创建文档。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_knowledge_remove_document",
    description: "按 ID 删除知识库文档。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_knowledge_list_documents",
    description: "列出知识库文档，可按类型或标签过滤。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
];

MODULE_BUILTIN_CATALOG.knowledge = [...KNOWLEDGE_BUILTIN_CATALOG, ...KNOWLEDGE_MODULE_TOOLS];

export function parseModuleKeyFromToolName(toolName: string): ModuleKey | null {
  if (!toolName.startsWith("omni_")) return null;
  const parts = toolName.split("_");
  if (parts.length < 3) return null;
  const moduleKey = parts[1] as ModuleKey;
  return moduleKey in MODULE_BUILTIN_CATALOG ? moduleKey : null;
}

export function getModuleBuiltinToolsFromCatalog(moduleKey: ModuleKey): BuiltinToolRegistration[] {
  return MODULE_BUILTIN_CATALOG[moduleKey] ?? [];
}

/** 供 DB 同步与设置页使用的完整目录 */
export function getAllBuiltinCatalogEntries(): BuiltinToolCatalogEntry[] {
  const items: BuiltinToolCatalogEntry[] = [];
  for (const [moduleKey, tools] of Object.entries(MODULE_BUILTIN_CATALOG) as [
    ModuleKey,
    BuiltinToolRegistration[] | undefined,
  ][]) {
    if (!tools) continue;
    for (const tool of tools) {
      items.push({
        tool_name: tool.name,
        module_key: moduleKey,
        description: tool.description,
      });
    }
  }
  return items;
}

/** 供设置页 OmniMCP 工具列表合并展示 */
export function getAllModuleBuiltinToolInfos(): ToolInfo[] {
  return getAllBuiltinCatalogEntries().map((entry) => ({
    name: entry.tool_name,
    description: entry.description,
  }));
}

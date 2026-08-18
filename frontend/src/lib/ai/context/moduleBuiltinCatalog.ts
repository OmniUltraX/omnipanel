import type { ModuleKey } from "../../paths";
import type { BuiltinToolCatalogEntry, ToolInfo } from "../../../ipc/bindings";
import { DATABASE_MODULE_TOOLS } from "../../../modules/database/ai/mcpTools";
import { DOCKER_MODULE_TOOLS } from "../../../modules/docker/ai/mcpTools";
import { FILES_MODULE_TOOLS } from "../../../modules/files/ai/mcpTools";
import { TERMINAL_MODULE_TOOLS } from "../../../modules/terminal/ai/mcpTools";
import { KNOWLEDGE_MODULE_TOOLS } from "../../../modules/knowledge/ai/mcpTools";
import { SSH_MODULE_TOOLS } from "../../../modules/server/ssh/ai/mcpTools";
import { WORKSPACE_MODULE_TOOLS } from "../../../modules/workspace/ai/mcpTools";
import {
  OMNIMCP_BUILTIN_MCP_PORT,
  OMNIMCP_BUILTIN_MCP_URL,
} from "../localServicePorts";
import type { BuiltinToolRegistration } from "./types";

/** 内置工具目录模块键（含无前端路由的 web 模块） */
type BuiltinCatalogModuleKey = ModuleKey | "web";

/** 与 Rust `BUILTIN_SERVICE_ID` 保持一致 */
export const OMNIMCP_BUILTIN_SERVICE_ID = "omnimcp-builtin";
/** 内置 OmniMCP HTTP 端口 / URL，与 Rust `BUILTIN_MCP_PORT` 一致（dev/release 不同） */
export { OMNIMCP_BUILTIN_MCP_PORT, OMNIMCP_BUILTIN_MCP_URL };

/** 与 Rust `builtin_tool_is_cross_module` 对齐：模块 Agent 也会注入这些 web 工具。 */
export const CROSS_MODULE_BUILTIN_TOOL_NAMES = new Set([
  "omni_plan_create",
  "omni_plan_add_step",
  "omni_plan_update_step",
  "omni_ask_user",
  "omni_web_search",
  "omni_zhihu_search",
  "omni_web_fetch",
]);

const MODULE_BUILTIN_CATALOG: Partial<Record<BuiltinCatalogModuleKey, BuiltinToolRegistration[]>> = {
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

/** 全局工具：Skill / Tag / Resource / load_skill / Workspace（module_key=web） */
const GLOBAL_BUILTIN_CATALOG: BuiltinToolRegistration[] = [
  {
    name: "omni_resource_get_profile",
    description:
      "获取资源档案：返回指定资源（SSH 主机 / 数据库连接等）的最新观测快照（hardware / services / overview / schema_summary 等各类最新一条）。供 AI 在处理新问题时快速了解资源历史状态。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_resource_find_similar",
    description:
      "查找相似资源（指纹匹配），并附带 related_skills。用于『p4→p7』复用；不足时再调 omni_skill_recall。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_resource_update_profile",
    description:
      "更新资源档案：手动或由 AI 追加一条观测记录（如部署服务清单、已知问题、运维笔记等）。不会覆盖历史，append-only。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_skill_recall",
    description:
      "召回相关 skill（向量 + 关键词混合），返回正文与 application_id。应用后务必调用 omni_skill_report_outcome。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_skill_extract_experience",
    description:
      "从任务经验创建 skill（SKILL.md + 向量化），可选关联资源/knowledge；支持 parent_skill_id 版本迭代。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_skill_refine",
    description:
      "改进已有 skill：创建新版本（旧版禁用），复制 knowledge 关联并向量化。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_skill_report_outcome",
    description:
      "回写 skill 应用结果（success/failure/partial），更新成功率。application_id 来自 omni_skill_recall。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_tag_list_tree",
    description: "列出全局标签树（扁平列表，含 path 与可选资源计数）。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_tag_list_resource",
    description: "列出某资源上的全部标签（含 source）。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_tag_attach",
    description:
      "为资源附加标签（path 支持树形路径）。业务标签请先征得用户确认；系统键可用 source=system。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "load_skill",
    description: "加载指定 Skill 的完整 SKILL.md 正文（渐进式披露）",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_knowledge_save_todolist",
    description:
      "将个人待办列表写入任务中心「我的待办」。仅当用户明确要求「记待办」「写到任务中心待办」时使用；制定执行计划请用 omni_knowledge_create_document；执行中进度跟踪请用 omni_plan_create。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_plan_create",
    description:
      "创建会话级任务计划（todolist），在 AI 侧栏顶部实时显示步骤进度。执行多步骤任务时的首选计划工具。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("UiDelegated 工具，由前端 planToolDispatcher 处理");
    },
  },
  {
    name: "omni_plan_add_step",
    description: "向已有会话级计划追加步骤。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("UiDelegated 工具，由前端 planToolDispatcher 处理");
    },
  },
  {
    name: "omni_plan_update_step",
    description:
      "更新会话级计划步骤的状态（pending → in_progress → completed/failed/skipped）。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("UiDelegated 工具，由前端 planToolDispatcher 处理");
    },
  },
  {
    name: "omni_ask_user",
    description:
      "MUST：凡需用户选择/确认/补充关键参数时调用（单选/多选/填空）。禁止正文纯文本列选项。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("UiDelegated 工具，由前端 askUserToolDispatcher 处理");
    },
  },
];

/** Rust 内置 web 工具（与 omnipanel-store BUILTIN_TOOL_SPECS 对齐） */
const WEB_BUILTIN_CATALOG: BuiltinToolRegistration[] = [
  ...GLOBAL_BUILTIN_CATALOG,
  ...WORKSPACE_MODULE_TOOLS,
  {
    name: "omni_web_search",
    description:
      "全网搜索公开信息；检索/查阅意图优先用本工具。默认 scope=web。涉及中文经验/讨论/评测，或全网结果不满意时，可改用 omni_zhihu_search 补充。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_zhihu_search",
    description:
      "知乎站内搜索(问题/回答/文章/用户)，适合中文知识、经验、讨论、评测类问题，或全网结果不足时补充。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
  {
    name: "omni_web_fetch",
    description:
      "抓取指定 URL 的网页正文；已知链接或需阅读某页全文时优先用本工具，可与 search 配合先搜后抓。默认本地直连转 Markdown，失败时降级 Jina Reader。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
];

MODULE_BUILTIN_CATALOG.web = WEB_BUILTIN_CATALOG;

/** Rust 内置 ssh 工具：omni_ssh_list_connections 是 Native（仅查表），需要占位条目让 catalog 完整。
 *  其余 omni_ssh_* 工具是 UiDelegated，由 SSH_MODULE_TOOLS 提供 handler。 */
const SSH_BUILTIN_CATALOG: BuiltinToolRegistration[] = [
  {
    name: "omni_ssh_list_connections",
    description: "列出已保存的 SSH 连接（不含凭据与完整 config），供外部 Agent 选择目标主机。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
];

MODULE_BUILTIN_CATALOG.ssh = [...SSH_BUILTIN_CATALOG, ...SSH_MODULE_TOOLS];

/** Rust 内置 docker 工具：omni_docker_list_connections 是 Native（仅查表），需要占位条目让 catalog 完整。
 *  其余 omni_docker_* 工具是 UiDelegated，由 DOCKER_MODULE_TOOLS 提供 handler。 */
const DOCKER_BUILTIN_CATALOG: BuiltinToolRegistration[] = [
  {
    name: "omni_docker_list_connections",
    description:
      "列出已保存的 Docker 连接（含本地 Engine / 远程 Engine / SSH Engine / 1Panel），供外部 Agent 选择目标。本地 Engine 的 connection_id 固定为 'docker-local'。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
];

MODULE_BUILTIN_CATALOG.docker = [...DOCKER_BUILTIN_CATALOG, ...DOCKER_MODULE_TOOLS];

/** Rust 内置 files 工具：omni_files_list_connections 是 Native（仅查表），需要占位条目让 catalog 完整。
 *  其余 omni_files_* 工具是 UiDelegated，由 FILES_MODULE_TOOLS 提供 handler。 */
const FILES_BUILTIN_CATALOG: BuiltinToolRegistration[] = [
  {
    name: "omni_files_list_connections",
    description:
      "列出已保存的文件管理器连接（含本机 / SFTP / FTP / S3）。本机连接 id 固定为 '__local__'。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("请通过 OmniMCP 内置服务调用");
    },
  },
];

MODULE_BUILTIN_CATALOG.files = [...FILES_BUILTIN_CATALOG, ...FILES_MODULE_TOOLS];

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
    BuiltinCatalogModuleKey,
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

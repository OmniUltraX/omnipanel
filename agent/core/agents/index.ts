import { databaseAgent } from "./database/index.js";
import { dockerAgent } from "./docker/index.js";
import { filesAgent } from "./files/index.js";
import { knowledgeAgent } from "./knowledge/index.js";
import { masterAgent } from "./master/index.js";
import { protocolAgent } from "./protocol/index.js";
import { serverAgent } from "./server/index.js";
import { sshAgent } from "./ssh/index.js";
import { terminalAgent } from "./terminal/index.js";
import type { ModuleAgentDefinition } from "./types.js";
import { workflowAgent } from "./workflow/index.js";

export type { ModuleAgentDefinition } from "./types.js";
export {
  createOmniMcpServers,
  OMNI_MCP_MODULE_HEADER,
  OMNI_MCP_URL,
} from "./omniMcp.js";

export { masterAgent } from "./master/index.js";
export { terminalAgent } from "./terminal/index.js";
export { databaseAgent } from "./database/index.js";
export { sshAgent } from "./ssh/index.js";
export { dockerAgent } from "./docker/index.js";
export { serverAgent } from "./server/index.js";
export { filesAgent } from "./files/index.js";
export { protocolAgent } from "./protocol/index.js";
export { workflowAgent } from "./workflow/index.js";
export { knowledgeAgent } from "./knowledge/index.js";

/** 全部模块 Agent（模型配置由 loadAgentConfigFile 等公共配置提供）。 */
export const moduleAgents: Record<string, ModuleAgentDefinition> = {
  master: masterAgent,
  terminal: terminalAgent,
  database: databaseAgent,
  ssh: sshAgent,
  docker: dockerAgent,
  server: serverAgent,
  files: filesAgent,
  protocol: protocolAgent,
  workflow: workflowAgent,
  knowledge: knowledgeAgent,
};

export const moduleAgentKeys = Object.keys(moduleAgents);

export function getModuleAgent(moduleKey: string): ModuleAgentDefinition | undefined {
  return moduleAgents[moduleKey];
}

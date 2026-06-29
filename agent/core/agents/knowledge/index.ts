import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const knowledgeAgent: ModuleAgentDefinition = {
  moduleKey: "knowledge",
  systemPrompt: resolveModuleSystemPrompt("knowledge"),
  mcpServers,
};

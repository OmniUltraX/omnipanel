import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const workflowAgent: ModuleAgentDefinition = {
  moduleKey: "workflow",
  systemPrompt: resolveModuleSystemPrompt("workflow"),
  mcpServers,
};

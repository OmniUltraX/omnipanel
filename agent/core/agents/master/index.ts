import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const masterAgent: ModuleAgentDefinition = {
  moduleKey: "master",
  systemPrompt: resolveModuleSystemPrompt("master"),
  mcpServers,
};

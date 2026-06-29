import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const dockerAgent: ModuleAgentDefinition = {
  moduleKey: "docker",
  systemPrompt: resolveModuleSystemPrompt("docker"),
  mcpServers,
};

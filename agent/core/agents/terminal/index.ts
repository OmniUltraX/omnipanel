import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const terminalAgent: ModuleAgentDefinition = {
  moduleKey: "terminal",
  systemPrompt: resolveModuleSystemPrompt("terminal"),
  mcpServers,
};

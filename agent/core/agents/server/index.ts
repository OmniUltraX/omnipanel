import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const serverAgent: ModuleAgentDefinition = {
  moduleKey: "server",
  systemPrompt: resolveModuleSystemPrompt("server"),
  mcpServers,
};

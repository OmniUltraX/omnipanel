import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const protocolAgent: ModuleAgentDefinition = {
  moduleKey: "protocol",
  systemPrompt: resolveModuleSystemPrompt("protocol"),
  mcpServers,
};

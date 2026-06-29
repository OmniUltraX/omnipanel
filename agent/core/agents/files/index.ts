import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const filesAgent: ModuleAgentDefinition = {
  moduleKey: "files",
  systemPrompt: resolveModuleSystemPrompt("files"),
  mcpServers,
};

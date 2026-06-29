import { resolveModuleSystemPrompt } from "../../systemPrompt.js";
import type { ModuleAgentDefinition } from "../types.js";
import { mcpServers } from "./mcp.js";

export const sshAgent: ModuleAgentDefinition = {
  moduleKey: "ssh",
  systemPrompt: resolveModuleSystemPrompt("ssh"),
  mcpServers,
};

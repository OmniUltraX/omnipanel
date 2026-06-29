import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

import { AgentSessionManager } from "../../core/index.js";
import {
  createAcpEventSink,
  notifyAcpErrorChunk,
  promptBlocksToText,
} from "./protocol.js";

const sessions = new AgentSessionManager();

function log(...args: unknown[]): void {
  console.error("[omniagent:acp]", ...args);
}

/** 启动 ACP stdio 适配器（供 OmniPanel 集成）。 */
export function startAcpServer(): void {
  const app = agent({ name: "omniagent" })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "omniagent",
        version: "1.0.0",
      },
      agentCapabilities: {
        promptCapabilities: {
          text: true,
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
          stdio: true,
        },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const sessionId = randomUUID();
      await sessions.open(sessionId, params.cwd, params.mcpServers ?? []);
      log("session/new", sessionId, "cwd=", params.cwd);
      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const userText = promptBlocksToText(params.prompt);
      if (!userText.trim()) {
        return { stopReason: "end_turn" as const };
      }

      const messageId = randomUUID();
      try {
        await sessions.prompt(params.sessionId, userText, createAcpEventSink(client, params.sessionId, messageId), {
          signal,
        });
        return { stopReason: "end_turn" as const };
      } catch (error) {
        if (signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        const message = error instanceof Error ? error.message : String(error);
        log("prompt error:", message);
        await notifyAcpErrorChunk(client, params.sessionId, message, randomUUID());
        return { stopReason: "refusal" as const };
      }
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      sessions.cancel(params.sessionId);
      log("session/cancel", params.sessionId);
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      await sessions.close(params.sessionId);
      return {};
    });

  const rawStdout = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const rawStdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  app.connect(ndJsonStream(rawStdout, rawStdin));
  log("ACP 模式已启动 (protocol", PROTOCOL_VERSION, ")");
}

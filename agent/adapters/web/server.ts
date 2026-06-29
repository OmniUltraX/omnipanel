import { randomUUID } from "node:crypto";
import http from "node:http";

import {
  AgentSessionManager,
  loadAgentConfigFile,
  resolveSkillsDirs,
  type AgentStreamEvent,
} from "../../core/index.js";
import { ensureWebConfigEnv, parseWebPort } from "./bootstrap.js";

const DEFAULT_PORT = 9477;
const sessions = new AgentSessionManager();
let defaultSessionId: string | null = null;

function log(...args: unknown[]): void {
  console.error("[omniagent:web]", ...args);
}

async function ensureDefaultSession(cwd?: string): Promise<string> {
  if (defaultSessionId && sessions.has(defaultSessionId)) {
    return defaultSessionId;
  }
  defaultSessionId = randomUUID();
  const workdir = cwd?.trim() || process.cwd();
  await sessions.open(defaultSessionId, workdir, []);
  log("session created", defaultSessionId, "cwd=", workdir);
  return defaultSessionId;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function writeSse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const config = loadAgentConfigFile(true);
  const session = defaultSessionId ? sessions.get(defaultSessionId) : undefined;
  writeJson(res, 200, {
    mode: "web",
    configured: Boolean(config),
    model: config?.model ?? null,
    baseUrl: config?.baseUrl ?? null,
    apiStandard: config?.apiStandard ?? null,
    mcpCount: config?.mcpServers?.length ?? 0,
    skillsDirs: resolveSkillsDirs(),
    sessionReady: Boolean(session),
    cwd: session?.cwd ?? process.cwd(),
  });
}

async function handlePrompt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { text?: string; cwd?: string };
  const userText = body.text?.trim() ?? "";
  if (!userText) {
    writeJson(res, 400, { error: "text 不能为空" });
    return;
  }

  const sessionId = await ensureDefaultSession(body.cwd);
  if (sessions.isRunning(sessionId)) {
    writeJson(res, 409, { error: "上一轮仍在执行中" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const send = (event: AgentStreamEvent | { type: "done" } | { type: "error"; message: string }) => {
    writeSse(res, event.type, event);
  };

  try {
    await sessions.prompt(sessionId, userText, async (event) => send(event));
    send({ type: "done" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      send({ type: "error", message: "已取消" });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "error", message });
    }
  } finally {
    res.end();
  }
}

async function handleCancel(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (defaultSessionId) {
    sessions.cancel(defaultSessionId);
  }
  writeJson(res, 200, { cancelled: true });
}

async function handleReset(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (defaultSessionId) {
    await sessions.close(defaultSessionId);
    defaultSessionId = null;
  }
  writeJson(res, 200, { reset: true });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      await handleStatus(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      await handlePrompt(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cancel") {
      await handleCancel(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/reset") {
      await handleReset(req, res);
      return;
    }
    writeJson(res, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      writeJson(res, 500, { error: message });
    } else {
      writeSse(res, "error", { type: "error", message });
      res.end();
    }
  }
}

/** 启动 Web HTTP 适配器（供 dev-ui assistant-ui 客户端连接）。 */
export function startWebServer(): void {
  ensureWebConfigEnv();
  const port = parseWebPort(DEFAULT_PORT);
  http.createServer((req, res) => {
    void handleRequest(req, res);
  }).listen(port, "127.0.0.1", () => {
    log(`Web API 已启动 http://127.0.0.1:${port}`);
    const config = loadAgentConfigFile();
    if (!config) {
      log("警告: 未找到配置。复制 debug-config.example.json → debug-config.json 并填写 API Key");
    }
  });
}

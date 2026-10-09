#!/usr/bin/env node
/**
 * Agent sidecar 参考进程：stdin/stdout 一行一条 JSON-RPC。
 * 协议见 docs/plugins/sidecar-agent.md
 * 自测：node scripts/check-agent-sidecar.mjs plugins-samples/agent-echo/bin/agent.mjs --source echo
 */
import readline from "node:readline";

const SOURCE_ID = "echo";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function card() {
  return {
    id: SOURCE_ID,
    title: "Echo",
    signedIn: true,
    account: "demo",
    tokenExpiresAtMs: null,
    catalogSource: "live",
    error: null,
    models: [{ id: "echo-1", name: "Echo", credits: null, badges: [] }],
  };
}

function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    send({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "非法 JSON" } });
    return;
  }
  const id = Number.isInteger(msg.id) ? msg.id : 0;
  const method = String(msg.method || "");
  if (method === "handshake") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        engine: SOURCE_ID,
        capabilities: ["status", "catalog", "chat"],
      },
    });
    return;
  }
  if (method === "status" || method === "catalog") {
    send({ jsonrpc: "2.0", id, result: card() });
    return;
  }
  if (method === "chat") {
    send({
      jsonrpc: "2.0",
      method: "chat_event",
      params: { id, event: { type: "content_delta", text: "hello" } },
    });
    send({
      jsonrpc: "2.0",
      method: "chat_event",
      params: { id, event: { type: "done", stop_reason: "end_turn" } },
    });
    send({ jsonrpc: "2.0", id, result: { ok: true } });
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `未知方法: ${method}` },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", onLine);

#!/usr/bin/env node
/**
 * check-agent-sidecar — Agent sidecar 一致性校验。
 *
 * 协议见 docs/plugins/sidecar-agent.md。用法：
 *   node scripts/check-agent-sidecar.mjs <bin/agent.mjs> [--source <id>]
 *   node scripts/check-agent-sidecar.mjs --cmd "node <bin/agent.mjs>" [--source <id>]
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);
let program = null;
let programArgs = [];
let target = null;
let expectSource = "";

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--cmd" && i + 1 < args.length) {
    const parts = args[i + 1].trim().split(/\s+/);
    program = parts[0];
    programArgs = parts.slice(1);
    i += 1;
  } else if (args[i] === "--source" && i + 1 < args.length) {
    expectSource = args[i + 1].trim();
    i += 1;
  } else if (!target) {
    target = args[i];
  }
}

if (!program && target) {
  if (/\.(mjs|js)$/i.test(target)) {
    program = process.execPath;
    programArgs = [target];
  } else {
    program = target;
  }
}
if (!program) {
  console.error('用法: node scripts/check-agent-sidecar.mjs <bin/agent.mjs|--cmd "..."> [--source <id>]');
  process.exit(2);
}

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`ok: ${name}`);
  else {
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const child = spawn(program, programArgs, { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();

function failAll(message) {
  for (const [id, waiter] of pending) {
    waiter.reject(new Error(message));
    pending.delete(id);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    failAll(`非 JSON: ${trimmed}`);
    return;
  }
  if (msg.method === "chat_event") {
    const id = msg.params?.id;
    const waiter = pending.get(id);
    if (waiter?.events) waiter.events.push(msg.params?.event);
    return;
  }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
  else waiter.resolve(msg.result);
});

child.on("exit", () => failAll("sidecar 已退出"));

function call(method, params, { stream = false } = {}) {
  const id = nextId;
  nextId += 1;
  const events = [];
  const result = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, events: stream ? events : null });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 8000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return result.then((value) => ({ value, events }));
}

const handshake = await call("handshake", {});
check("handshake.protocolVersion", handshake.value?.protocolVersion === 1, JSON.stringify(handshake.value));
check(
  "handshake.capabilities",
  ["status", "catalog", "chat"].every((name) => handshake.value?.capabilities?.includes(name)),
  JSON.stringify(handshake.value?.capabilities),
);

const status = await call("status", {});
check("status.signedIn", typeof status.value?.signedIn === "boolean", JSON.stringify(status.value));
check("status.models", Array.isArray(status.value?.models), JSON.stringify(status.value?.models));
if (expectSource) {
  check("status.id", status.value?.id === expectSource, status.value?.id);
}

const catalog = await call("catalog", {});
check("catalog.models", Array.isArray(catalog.value?.models), JSON.stringify(catalog.value));

const chat = await call(
  "chat",
  {
    model: "echo-1",
    request: {
      model: "echo-1",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
    proxy: null,
  },
  { stream: true },
);
check("chat.ok", chat.value?.ok === true, JSON.stringify(chat.value));
check(
  "chat.content_delta",
  chat.events.some((event) => event?.type === "content_delta" && typeof event.text === "string"),
  JSON.stringify(chat.events),
);

let unknownFailed = false;
try {
  await call("nope", {});
} catch (err) {
  unknownFailed = /未知方法/.test(String(err.message || err));
}
check("unknown method", unknownFailed);

child.kill();
if (failures.length > 0) {
  console.error(`FAIL ${failures.length}`);
  process.exit(1);
}
console.log("agent sidecar ok");

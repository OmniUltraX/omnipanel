#!/usr/bin/env node
/**
 * DBX Agent 协议 v2 模拟：先发 ready 横幅，再走 handshake / open_session / execute_query。
 * 收到 v1 方法名（connect / execute / version）时拒绝，用来锁方言。
 */

import readline from "node:readline";

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
  );
}

let sessionOpen = false;
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    fail(0, `请求不是合法 JSON-RPC: ${err}`);
    return;
  }
  const id = req.id ?? 0;
  const method = req.method;
  if (method === "handshake") {
    reply(id, {
      protocolVersion: 2,
      agentProtocolVersion: 2,
      capabilities: ["connect", "multi_session"],
    });
    return;
  }
  if (method === "connect" || method === "execute" || method === "version") {
    fail(id, `v2 dialect locked: ${method}`);
    return;
  }
  if (method === "open_session") {
    sessionOpen = true;
    reply(id, { ok: true, agentSessionId: req.params?.agentSessionId ?? "s1" });
    return;
  }
  if (method === "close_session" || method === "shutdown") {
    sessionOpen = false;
    reply(id, { ok: true });
    rl.close();
    return;
  }
  if (!sessionOpen) {
    fail(id, "尚未 open_session");
    return;
  }
  switch (method) {
    case "validate_connection":
      reply(id, "DBX-Mock-V2 1.0");
      break;
    case "list_tables":
      reply(id, [{ name: "EMP", table_type: "TABLE" }, { name: "DEPT" }]);
      break;
    case "list_databases":
      reply(id, ["ORCL"]);
      break;
    case "get_columns":
      reply(id, [
        { name: "ID", type: "NUMBER" },
        { name: "NAME", type: "VARCHAR2" },
      ]);
      break;
    case "get_table_ddl":
      reply(id, { ddl: "CREATE TABLE EMP (ID NUMBER)" });
      break;
    case "execute_query": {
      const sql = req.params?.sql ?? "";
      reply(id, {
        columns: ["SQL"],
        rows: [[sql]],
        affected_rows: 0,
      });
      break;
    }
    default:
      fail(id, `未知方法: ${method}`);
  }
});

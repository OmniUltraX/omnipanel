#!/usr/bin/env node
/**
 * DBX 风格外部 agent 样板：stdin/stdout 一行一条 JSON-RPC。
 * 打包进 omni.engine.oracle，验证「安装插件 → 连接对话框芯片 → sidecar 建连」。
 * 真实 DBX 插件把 entry.driver 换成 java -jar 的 agent.jar 即可。
 */

import readline from "node:readline";

function canonical(method) {
  switch (method) {
    case "executeQuery":
      return "execute";
    case "listTables":
      return "list_tables";
    case "getColumns":
      return "describe_table";
    case "getTableDdl":
      return "show_create_table";
    case "listDatabases":
      return "list_databases";
    case "testConnection":
    case "test_connection":
      return "version";
    case "listSchemas":
      return "list_schemas";
    default:
      return method;
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
  );
}

let connected = false;
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
  const method = canonical(req.method);
  if (method === "handshake") {
    reply(id, {
      protocolVersion: 1,
      engine: "oracle",
      capabilities: ["connect", "query", "preview", "metadata", "extra"],
    });
    return;
  }
  if (method === "connect") {
    connected = true;
    reply(id, { ok: true });
    return;
  }
  if (method === "disconnect") {
    connected = false;
    reply(id, { ok: true, bye: true });
    rl.close();
    return;
  }
  if (!connected) {
    fail(id, "尚未 connect");
    return;
  }
  switch (method) {
    case "version":
      reply(id, "DBX-Mock 1.0");
      break;
    case "list_tables":
      reply(id, ["EMP", "DEPT"]);
      break;
    case "list_databases":
    case "list_schemas":
      reply(id, ["ORCL"]);
      break;
    case "describe_table":
      reply(id, [
        { name: "ID", type: "NUMBER" },
        { name: "NAME", type: "VARCHAR2" },
      ]);
      break;
    case "show_create_table":
      reply(id, "CREATE TABLE EMP (ID NUMBER, NAME VARCHAR2(64))");
      break;
    case "execute":
      reply(id, {
        columns: ["X"],
        rows: [[1]],
        rowsAffected: 0,
      });
      break;
    default:
      fail(id, `未知方法: ${method}`);
  }
});

#!/usr/bin/env node
/**
 * check-dbx-agent — DBX sidecar 一致性校验（第三方 engine 上线门禁）。
 *
 * 协议见 docs/plugins/sidecar-dbx.md。用法：
 *   node scripts/check-dbx-agent.mjs <bin/agent.mjs>
 *   node scripts/check-dbx-agent.mjs --cmd "java -jar <bin/agent.jar>"
 *   node scripts/check-dbx-agent.mjs --cmd "<native-bin>" [--engine oracle]
 *
 * 断言：handshake 协议版本 → connect → version 非空 → list_tables 数组 →
 * describe_table/show_create_table/execute/preview 形状 → DBX 别名同义 →
 * 未 connect 调 execute 被拒 → disconnect bye。任一失败即非零退出。
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);
let program = null;
let programArgs = [];
let target = null;
let expectEngine = "";

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--cmd" && i + 1 < args.length) {
    const parts = args[i + 1].trim().split(/\s+/);
    program = parts[0];
    programArgs = parts.slice(1);
    i += 1;
  } else if (args[i] === "--engine" && i + 1 < args.length) {
    expectEngine = args[i + 1].trim();
    i += 1;
  } else if (!target) {
    target = args[i];
  }
}

if (!program && target) {
  if (/\.jar$/i.test(target)) {
    const java = process.env.OMNIPANEL_DBX_JAVA;
    if (!java) {
      console.error("FAIL: .jar 需要 OMNIPANEL_DBX_JAVA 指向 java（见 sidecar-dbx.md 拉起规则）");
      process.exit(2);
    }
    program = java;
    programArgs = ["-Dfile.encoding=UTF-8", "-jar", target];
  } else if (/\.(mjs|js)$/i.test(target)) {
    program = process.execPath;
    programArgs = [target];
  } else {
    program = target;
    programArgs = [];
  }
}
if (!program) {
  console.error('用法: node scripts/check-dbx-agent.mjs <bin/agent.mjs|--cmd "..."> [--engine <key>]');
  process.exit(2);
}

const failures = [];
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const child = spawn(program, programArgs, { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const cb = pending.get(msg.id);
  if (cb) {
    pending.delete(msg.id);
    cb(msg);
  }
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`, (err) => {
      if (err) reject(err);
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC 超时: ${method}`));
      }
    }, 15000);
  });
}
function isErr(msg) {
  return !!msg.error;
}

let exited = false;
child.on("exit", () => {
  exited = true;
});

try {
  const hs = await call("handshake", {});
  check("handshake 成功", !isErr(hs), JSON.stringify(hs).slice(0, 200));
  const pv = hs.result?.protocolVersion ?? hs.result?.protocol_version;
  check("protocolVersion=1", pv === 1, `got ${pv}`);
  if (expectEngine) check("engine 一致", hs.result?.engine === expectEngine, `got ${hs.result?.engine}`);
  check("capabilities 含 connect/query", Array.isArray(hs.result?.capabilities) && hs.result.capabilities.includes("connect"), JSON.stringify(hs.result?.capabilities));

  const preAuth = await call("execute", { sql: "SELECT 1" });
  check("未 connect 被拒", isErr(preAuth) && /尚未 connect/.test(preAuth.error?.message ?? ""), JSON.stringify(preAuth).slice(0, 160));

  const conn = await call("connect", { dbType: "demo", host: "127.0.0.1", port: 1, user: "u", password: "p", database: "d", ssl: false });
  check("connect ok", !isErr(conn) && conn.result?.ok === true, JSON.stringify(conn).slice(0, 160));

  const ver = await call("version", {});
  check("version 非空字符串", !isErr(ver) && typeof ver.result === "string" && ver.result.length > 0, JSON.stringify(ver).slice(0, 160));
  const verAlias = await call("testConnection", {});
  check("别名 testConnection 同义", !isErr(verAlias), JSON.stringify(verAlias).slice(0, 160));

  const tables = await call("list_tables", {});
  check("list_tables 数组", !isErr(tables) && Array.isArray(tables.result), JSON.stringify(tables).slice(0, 160));
  const tablesAlias = await call("listTables", {});
  check("别名 listTables 同义", !isErr(tablesAlias) && Array.isArray(tablesAlias.result), JSON.stringify(tablesAlias).slice(0, 160));

  const firstTable = Array.isArray(tables.result) && tables.result.length > 0 ? String(tables.result[0]) : "DEMO";
  const cols = await call("describe_table", { table: firstTable });
  const colsOk = !isErr(cols) && Array.isArray(cols.result) && cols.result.every((c) => c && typeof c.name === "string");
  check("describe_table 形状", colsOk, JSON.stringify(cols).slice(0, 200));
  const colsAlias = await call("getColumns", { table: firstTable });
  check("别名 getColumns 同义", !isErr(colsAlias), JSON.stringify(colsAlias).slice(0, 160));

  const ddl = await call("show_create_table", { table: firstTable });
  check("show_create_table 字符串", !isErr(ddl) && typeof ddl.result === "string", JSON.stringify(ddl).slice(0, 160));

  const q = await call("execute", { sql: "SELECT 1" });
  const qOk = !isErr(q) && Array.isArray(q.result?.columns) && Array.isArray(q.result?.rows);
  check("execute QueryResult 形状", qOk, JSON.stringify(q).slice(0, 200));
  const qAlias = await call("executeQuery", { sql: "SELECT 1" });
  check("别名 executeQuery 同义", !isErr(qAlias), JSON.stringify(qAlias).slice(0, 160));

  const pv2 = await call("preview", { table: firstTable, limit: 10, offset: 0 });
  check("preview QueryResult 形状", !isErr(pv2) && Array.isArray(pv2.result?.columns), JSON.stringify(pv2).slice(0, 200));

  const bye = await call("disconnect", {});
  check("disconnect bye", !isErr(bye) && bye.result?.bye === true, JSON.stringify(bye).slice(0, 160));
} catch (e) {
  check("全流程无异常", false, String(e?.message ?? e));
} finally {
  child.stdin.end();
  setTimeout(() => {
    if (!exited) child.kill();
  }, 2000).unref?.();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\n全部通过：该 agent 符合 DBX v1 最小集，可以打包。");

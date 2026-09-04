# DBX Sidecar 协议（EngineSession v1）

第三方数据库引擎**不写 inproc Rust**，写一个独立进程（任意语言，含 Rust）实现本协议即可。
宿主按 `plugin.json` 的 `runtime=sidecar + entry.driver` 拉起它，经 stdin/stdout 一行一条 JSON-RPC 调用。
崩溃只影响单个插件进程，不会拖垮主程序。

单源实现：`crates/omnipanel-db/src/sidecar/protocol.rs`（握手/别名/结构）、
`serve.rs`（服务端分发）、`engine.rs`（拉起规则）、`dbx_dialect.rs`（DBX 方言容错）。
本文是面向第三方的人话版；冲突时以 Rust 单源为准。

## 1. 传输

- `stdin` 读请求，`stdout` 写响应，**一行一条 JSON**，UTF-8，`\n` 结尾。
- `stderr` 只打日志，不参与协议（宿主直接忽略/透出到日志面板）。
- JSON-RPC 2.0 信封：

```json
// 请求
{ "jsonrpc": "2.0", "id": 7, "method": "execute", "params": { "sql": "SELECT 1" } }
// 成功
{ "jsonrpc": "2.0", "id": 7, "result": { "columns": ["X"], "rows": [[1]], "rowsAffected": 0 } }
// 失败
{ "jsonrpc": "2.0", "id": 7, "error": { "code": -32000, "message": "尚未 connect" } }
```

- 非法 JSON 请求回 `id: 0` 的 error，不挂断。
- 空行忽略。

## 2. 生命周期

```
handshake → connect → version / list_tables / ... → disconnect(bye:true)
```

- `connect` 之前只允许 `handshake/connect/disconnect`，其它一律 `"尚未 connect"`。
- `disconnect` 返回 `{ "ok": true, "bye": true }` 后服务端可退出，宿主也会杀进程。
- 宿主按连接缓存进程（同 `db_type|host|port|user|...` 复用），空闲 ~30min 回收；单次 RPC 超时 35s。

## 3. 方法名归一（大小写敏感，按原样匹配后归一）

| 发什么 | 实际按什么执行 |
|---|---|
| `executeQuery` | `execute` |
| `listTables` | `list_tables` |
| `getColumns` | `describe_table` |
| `getTableDdl` | `show_create_table` |
| `listDatabases` | `list_databases` |
| `listSchemas` | `list_schemas` |
| `testConnection` / `test_connection` | `version` |
| 其它 | 原样透传（扩展方法走 `handle_extra`） |

第三方实现**任选一边**：直接实现规范名，或实现 DBX 别名，宿主都会归一。

## 4. 方法清单（第三方最小集）

| 方法 | params | result |
|---|---|---|
| `handshake` | `{}` | `{ "protocolVersion": 1, "engine": "<engineKey>", "capabilities": ["connect","query","preview","metadata","extra"] }` |
| `connect` | `ConnectParams`（下表） | `{ "ok": true }` |
| `version` | `{}` | `"DBX-Mock 1.0"`（字符串，连接测试用） |
| `list_tables` | `{}` | `["EMP","DEPT"]` |
| `list_databases` / `list_schemas` | `{}` | `["ORCL"]` |
| `describe_table` | `{ "table": "EMP" }` | `[{ "name": "ID", "type": "NUMBER" }]`（`type`/`data_type`/`dataType` 均认） |
| `show_create_table` | `{ "table": "EMP" }` | `"CREATE TABLE ..."`（字符串） |
| `execute` | `{ "sql": "SELECT ..." }` | `QueryResult`（下表） |
| `preview` | `{ "table": "EMP", "limit": 100, "offset": 0, "orderBy?": null, "whereClause?": null }` | `QueryResult` |
| `disconnect` | `{}` | `{ "ok": true, "bye": true }` |

可选扩展（声明了才会被调）：`count`、`create_database`、`drop_table`、redis/mongo 专用 ops。
未知方法回 error，不要静默成功。

### ConnectParams

```json
{
  "dbType": "oracle", "host": "127.0.0.1", "port": 1521,
  "user": "scott", "password": "***", "database": "ORCL", "ssl": false
}
```

- 字段名 camelCase；多余字段（如 `sid/sysdba`）**必须忽略**，不要报错。
- `database` 为空时服务端填默认库（mongo→admin 等）；第三方按自己引擎定即可。

### QueryResult（wire 为 camelCase）

```json
{ "columns": ["X"], "rows": [[1]], "rowsAffected": 0 }
```

- `rowsAffected` 兼容 `affected_rows` / `rows_affected` 三种写法。
- 单元格为 JSON 值；DBX 的数字字符串（如 `"123"`）宿主会尝试转数字，第三方直接回数字最稳。

## 5. 拉起规则（`entry.driver` 相对插件安装目录）

| 后缀 | 宿主实际执行 |
|---|---|
| `.js` / `.mjs` | `node <driver>`（需 PATH 有 node） |
| `.jar` | `java -jar <driver>`（`OMNIPANEL_DBX_JAVA` → 捆绑 JRE `plugins/.dbx-jre/21`，不 fallback 到 PATH 假 java；附 `-Dfile.encoding=UTF-8`） |
| 其它（含无后缀 / `.exe`） | 直接执行该文件（**Rust 模板走这条**，见 `engine-sidecar` 脚手架） |

- driver 不存在 → 启动失败，连接对话框报错，不回退到其它引擎。
- 已激活插件声明的 `engineKey` 即被“认领”，同名 sqlx 兼容驱动不再静默接管。

## 6. 安全与运维

- 口令只经 `connect` params 进 sidecar 进程内存，不写盘；不要在 `version/execute` 错误里回显口令。
- prod 主机访问仍受宿主连接 `env_tag` 管控；sidecar 绕不过（网络出口在 agent 侧，**不要**直连 prod 做写操作而不确认）。
- 超时/崩溃：宿主 kill + 按指纹重建；agent 应做到无状态（connect 后状态只放内存，断线重连即可恢复）。
- 日志打 `stderr`，`stdout` 只能是协议行，多一个 `console.log` 就会污染协议流。

## 7. 自测（合入前必跑）

```bash
# Node 模板 / 任意 agent 一律过同一套断言
node scripts/check-dbx-agent.mjs plugins-samples/dbx-oracle/bin/agent.mjs
node scripts/check-dbx-agent.mjs plugins-custom/<mine>/bin/agent.mjs
node scripts/check-dbx-agent.mjs --cmd "java -jar plugins-custom/<mine>/bin/agent.jar"
```

检查项：handshake 协议版本→connect→version 非空→list_tables 数组→
describe/execute 形状→DBX 别名（`listTables/getColumns/executeQuery` 同义）→
未 connect 调 execute 被拒→disconnect bye。全部绿才打包：

```bash
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/<mine> <mine>.omni-plugin
```

//! 宿主侧：拉起 sidecar 进程，把 JSON-RPC 伪装成 [`DbDriver`]。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::sidecar::dbx_dialect::{
    count_sql, dbx_open_session_params, decode_columns, decode_dbx_query_result, decode_ddl,
    decode_table_names, decode_version, extract_count, parse_jsonrpc_line, preview_sql,
    AgentDialect,
};
use crate::sidecar::engine::{EngineKind, EngineLaunch};
use crate::sidecar::protocol::{
    decode_query_result, ConnectParams, CountParams, CreateDatabaseParams, ExecuteParams,
    HandshakeResult, PreviewParams, RpcRequest, PROTOCOL_VERSION,
};
use crate::{DbDriver, DbParams, QueryResult};

const RPC_TIMEOUT: Duration = Duration::from_secs(35);
const AGENT_IDLE_TTL: Duration = Duration::from_secs(30 * 60);

struct SidecarIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

struct SidecarInner {
    child: Mutex<Child>,
    io: Mutex<SidecarIo>,
}

/// 可克隆句柄：同一连接复用同一个 sidecar 进程。最后一个句柄 drop 时才杀进程。
#[derive(Clone)]
pub struct SidecarDriver {
    inner: Arc<SidecarInner>,
    dialect: AgentDialect,
    db_type: String,
    /// 会话默认 schema / keyspace / graph database，供 list_tables / get_columns 透传。
    database: String,
}

struct CachedAgent {
    driver: SidecarDriver,
    last_used: Instant,
}

fn engine_agents() -> &'static Mutex<HashMap<String, CachedAgent>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedAgent>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn params_fingerprint(params: &DbParams) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        params.db_type,
        params.host,
        params.port,
        params.user,
        params.password,
        params.database,
        params.ssl,
        params.sid,
        params.sysdba
    )
}

fn agent_cache_key(launch: &EngineLaunch, params: &DbParams) -> String {
    format!("{}|{}", launch.cache_id(), params_fingerprint(params))
}

/// 连接删除或凭据变更后丢掉常驻 agent。
pub async fn evict_clickhouse(params: &DbParams) {
    evict_engine(EngineKind::ClickHouse, params).await;
}

pub async fn evict_engine(kind: EngineKind, params: &DbParams) {
    evict_launch(&EngineLaunch::Builtin(kind), params).await;
}

/// 关掉引擎插件时丢掉该种类下所有常驻 sidecar，避免禁用后仍复用缓存进程。
pub async fn evict_all_of_kind(kind: EngineKind) {
    let prefix = format!("{}|", kind.as_str());
    engine_agents()
        .lock()
        .await
        .retain(|key, _| !key.starts_with(&prefix));
}

pub async fn evict_launch(launch: &EngineLaunch, params: &DbParams) {
    engine_agents()
        .lock()
        .await
        .remove(&agent_cache_key(launch, params));
}

/// 安装/覆盖第三方 sidecar 后丢掉所有外部 agent 缓存，避免仍复用旧进程。
pub async fn evict_all_external_launches() {
    engine_agents()
        .lock()
        .await
        .retain(|key, _| !key.starts_with("ext:"));
}

fn is_sidecar_dead_error(err: &OmniError) -> bool {
    let text = err.to_string();
    text.contains("已退出")
        || text.contains("写入 sidecar 失败")
        || text.contains("flush sidecar 失败")
        || text.contains("读取 sidecar 失败")
}

impl SidecarDriver {
    async fn process_alive(&self) -> bool {
        let mut child = self.inner.child.lock().await;
        match child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    }
    pub async fn spawn(binary: &Path, params: &DbParams) -> OmniResult<Self> {
        Self::spawn_cmd(binary, &[], params).await
    }

    pub async fn spawn_cmd(program: &Path, args: &[String], params: &DbParams) -> OmniResult<Self> {
        if args.first().map(String::as_str) == Some("-jar") {
            if !program.is_file() {
                return Err(OmniError::not_found(
                    "未找到捆绑 JRE，请重新安装该引擎",
                ));
            }
            let java = program.to_path_buf();
            let healthy = tokio::task::spawn_blocking(move || {
                crate::sidecar::engine::java_version_ok(&java)
            })
            .await
            .unwrap_or(false);
            if !healthy {
                return Err(OmniError::connection(
                    "捆绑 JRE 无法执行 java -version，请重新安装该引擎",
                ));
            }
        }
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            OmniError::connection(format!(
                "无法启动数据库 sidecar {}: {e}",
                program.display()
            ))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            OmniError::internal("sidecar stdin 不可用")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            OmniError::internal("sidecar stdout 不可用")
        })?;
        let driver = Self {
            inner: Arc::new(SidecarInner {
                child: Mutex::new(child),
                io: Mutex::new(SidecarIo {
                    stdin,
                    stdout: BufReader::new(stdout),
                    next_id: 1,
                }),
            }),
            dialect: AgentDialect::OmniV1,
            db_type: params.db_type.clone(),
            database: params.database.clone(),
        };
        let handshake: HandshakeResult = driver.rpc_parse("handshake", json!({})).await?;
        let session_id = format!(
            "omni-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let dialect = AgentDialect::from_handshake(&handshake, session_id.clone());
        let driver = Self {
            inner: driver.inner,
            dialect,
            db_type: params.db_type.clone(),
            database: params.database.clone(),
        };
        match &driver.dialect {
            AgentDialect::OmniV1 => {
                if handshake.protocol_version != PROTOCOL_VERSION {
                    return Err(OmniError::connection(format!(
                        "sidecar 协议版本不匹配: 宿主 {PROTOCOL_VERSION} vs 客体 {}",
                        handshake.protocol_version
                    )));
                }
                let _: Value = driver
                    .rpc(
                        "connect",
                        serde_json::to_value(ConnectParams::from(params)).unwrap_or(Value::Null),
                    )
                    .await?;
            }
            AgentDialect::DbxV2 { .. } => {
                let _: Value = driver
                    .rpc("open_session", dbx_open_session_params(params, &session_id))
                    .await?;
            }
        }
        Ok(driver)
    }

    fn schema_rpc_params(&self) -> Value {
        super::dbx_dialect::dbx_schema_params(&self.database)
    }

    fn table_rpc_params(&self, table: &str) -> Value {
        super::dbx_dialect::dbx_table_params(&self.database, table)
    }

    pub async fn list_databases(&self) -> OmniResult<Vec<String>> {
        let value = self.rpc("list_databases", json!({})).await?;
        decode_table_names(value).map_err(OmniError::database)
    }

    pub async fn describe_table(&self, table: &str) -> OmniResult<Vec<(String, String)>> {
        let value = self
            .rpc("describe_table", self.table_rpc_params(table))
            .await?;
        let columns = decode_columns(value).map_err(OmniError::database)?;
        Ok(columns
            .into_iter()
            .map(|col| (col.name, col.column_type))
            .collect())
    }

    pub async fn create_database(&self, name: &str) -> OmniResult<()> {
        let _: Value = self
            .rpc(
                "create_database",
                serde_json::to_value(CreateDatabaseParams {
                    name: name.to_string(),
                })
                .unwrap_or(Value::Null),
            )
            .await?;
        Ok(())
    }

    pub async fn show_create_table(&self, table: &str) -> OmniResult<String> {
        let value = self
            .rpc("show_create_table", self.table_rpc_params(table))
            .await?;
        match value {
            Value::String(s) => Ok(s),
            other => Ok(decode_ddl(other)),
        }
    }

    pub async fn invoke(&self, method: &str, params: Value) -> OmniResult<Value> {
        self.rpc(method, params).await
    }

    pub async fn rpc_parse<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> OmniResult<T> {
        let value = self.rpc(method, params).await?;
        serde_json::from_value(value)
            .map_err(|e| OmniError::database(format!("{method} 返回非法")).with_cause(e.to_string()))
    }

    async fn rpc(&self, method: &str, params: Value) -> OmniResult<Value> {
        let outbound = self.dialect.outbound_method(method).to_string();
        let params = self.dialect.prepare_params(method, params);
        let mut io = self.inner.io.lock().await;
        let id = io.next_id;
        io.next_id += 1;
        let request = RpcRequest::new(id, outbound, params);
        let mut line = serde_json::to_string(&request).map_err(|e| {
            OmniError::internal("序列化 sidecar 请求失败").with_cause(e.to_string())
        })?;
        line.push('\n');
        io.stdin.write_all(line.as_bytes()).await.map_err(|e| {
            OmniError::connection("写入 sidecar 失败").with_cause(e.to_string())
        })?;
        io.stdin.flush().await.map_err(|e| {
            OmniError::connection("flush sidecar 失败").with_cause(e.to_string())
        })?;

        let deadline = Instant::now() + RPC_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(OmniError::new(ErrorCode::Timeout, "sidecar 响应超时"));
            }
            let mut response_line = String::new();
            let read = timeout(remaining, io.stdout.read_line(&mut response_line))
                .await
                .map_err(|_| OmniError::new(ErrorCode::Timeout, "sidecar 响应超时"))?
                .map_err(|e| {
                    OmniError::connection("读取 sidecar 失败").with_cause(e.to_string())
                })?;
            if read == 0 {
                return Err(OmniError::connection("sidecar 已退出"));
            }
            let Some(response) = parse_jsonrpc_line(&response_line) else {
                continue;
            };
            if let Some(err) = response.error {
                return Err(OmniError::database(err.message));
            }
            return Ok(response.result.unwrap_or(Value::Null));
        }
    }
}

impl Drop for SidecarInner {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

#[async_trait]
impl DbDriver for SidecarDriver {
    async fn version(&self) -> OmniResult<String> {
        Ok(decode_version(self.rpc("version", json!({})).await?))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let value = self.rpc("list_tables", self.schema_rpc_params()).await?;
        decode_table_names(value).map_err(OmniError::database)
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let value = self
            .rpc(
                "execute",
                serde_json::to_value(ExecuteParams {
                    sql: sql.to_string(),
                })
                .unwrap_or(Value::Null),
            )
            .await?;
        if self.dialect.is_dbx_v2() {
            decode_dbx_query_result(value).map_err(OmniError::database)
        } else {
            decode_query_result(value).map_err(OmniError::database)
        }
    }

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        if self.dialect.is_dbx_v2() {
            return self
                .execute(&preview_sql(
                    &self.db_type,
                    table,
                    limit,
                    offset,
                    order_by,
                    where_clause,
                ))
                .await;
        }
        let value = self
            .rpc(
                "preview",
                serde_json::to_value(PreviewParams {
                    table: table.to_string(),
                    limit,
                    offset,
                    order_by: order_by.map(str::to_string),
                    where_clause: where_clause.map(str::to_string),
                })
                .unwrap_or(Value::Null),
            )
            .await?;
        decode_query_result(value).map_err(OmniError::database)
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        if self.dialect.is_dbx_v2() {
            let result = self
                .execute(&count_sql(&self.db_type, table, where_clause))
                .await?;
            return Ok(extract_count(&result));
        }
        let value = self
            .rpc(
                "count",
                serde_json::to_value(CountParams {
                    table: table.to_string(),
                    where_clause: where_clause.map(str::to_string),
                })
                .unwrap_or(Value::Null),
            )
            .await?;
        match value {
            Value::Number(n) => Ok(n.as_i64().unwrap_or(0)),
            Value::String(s) => Ok(s.parse().unwrap_or(0)),
            _ => Ok(0),
        }
    }
}

/// 解析 ClickHouse sidecar 可执行文件：环境变量 → 主程序同目录 → 已安装插件目录。
pub fn resolve_clickhouse_sidecar(plugins_root: Option<&Path>) -> OmniResult<PathBuf> {
    resolve_sidecar(EngineKind::ClickHouse, plugins_root)
}

pub fn resolve_sidecar(kind: EngineKind, plugins_root: Option<&Path>) -> OmniResult<PathBuf> {
    let env_name = kind.env_var();
    if let Ok(explicit) = std::env::var(&env_name) {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(OmniError::not_found(format!(
            "{env_name} 指向的文件不存在: {}",
            path.display()
        )));
    }

    if cfg!(debug_assertions) && running_as_host_app() {
        ensure_dev_sidecar_built(kind);
    }

    if let Some(found) = search_sidecar_binary(kind, plugins_root) {
        return Ok(found);
    }

    let file_name = sidecar_file_name(kind.bin_stem());
    Err(OmniError::not_found(format!(
        "未找到 {} sidecar（{file_name}）。请与主程序放在同一目录，或设置 {env_name}。",
        kind.as_str()
    )))
}

pub async fn connect_clickhouse(params: &DbParams) -> OmniResult<SidecarDriver> {
    connect_engine(EngineKind::ClickHouse, params).await
}

pub async fn connect_engine(kind: EngineKind, params: &DbParams) -> OmniResult<SidecarDriver> {
    connect_launch(&EngineLaunch::Builtin(kind), params).await
}

pub async fn connect_launch(launch: &EngineLaunch, params: &DbParams) -> OmniResult<SidecarDriver> {
    match connect_launch_once(launch, params).await {
        Ok(driver) => Ok(driver),
        Err(err) if is_sidecar_dead_error(&err) => {
            evict_launch(launch, params).await;
            connect_launch_once(launch, params).await
        }
        Err(err) => Err(err),
    }
}

async fn connect_launch_once(
    launch: &EngineLaunch,
    params: &DbParams,
) -> OmniResult<SidecarDriver> {
    let key = agent_cache_key(launch, params);
    {
        let mut cache = engine_agents().lock().await;
        if let Some(entry) = cache.get_mut(&key) {
            if entry.last_used.elapsed() < AGENT_IDLE_TTL {
                let driver = entry.driver.clone();
                drop(cache);
                if driver.process_alive().await {
                    let mut cache = engine_agents().lock().await;
                    if let Some(entry) = cache.get_mut(&key) {
                        entry.last_used = Instant::now();
                    }
                    return Ok(driver);
                }
                engine_agents().lock().await.remove(&key);
            } else {
                cache.remove(&key);
            }
        }
    }

    let launch_owned = launch.clone();
    let params_clone = params.clone();
    let (program, args) = tokio::task::spawn_blocking(move || resolve_launch(&launch_owned, None))
        .await
        .map_err(|e| OmniError::internal("解析 sidecar 中断").with_cause(e.to_string()))??;
    let driver = SidecarDriver::spawn_cmd(&program, &args, &params_clone).await?;

    let alive_cached = {
        let cache = engine_agents().lock().await;
        cache.get(&key).map(|entry| {
            (
                entry.last_used.elapsed() < AGENT_IDLE_TTL,
                entry.driver.clone(),
            )
        })
    };
    if let Some((fresh, cached)) = alive_cached {
        if fresh && cached.process_alive().await {
            let mut cache = engine_agents().lock().await;
            if let Some(entry) = cache.get_mut(&key) {
                entry.last_used = Instant::now();
                return Ok(entry.driver.clone());
            }
        }
    }

    let mut cache = engine_agents().lock().await;
    cache.insert(
        key,
        CachedAgent {
            driver: driver.clone(),
            last_used: Instant::now(),
        },
    );
    Ok(driver)
}

fn resolve_launch(
    launch: &EngineLaunch,
    plugins_root: Option<&Path>,
) -> OmniResult<(PathBuf, Vec<String>)> {
    match launch {
        EngineLaunch::Builtin(kind) => Ok((resolve_sidecar(*kind, plugins_root)?, Vec::new())),
        EngineLaunch::External { program, args } => {
            if !program.is_file() {
                return Err(OmniError::not_found(format!(
                    "外部数据库 agent 不存在: {}",
                    program.display()
                )));
            }
            Ok((program.clone(), args.clone()))
        }
    }
}

pub(crate) fn sidecar_file_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

pub(crate) fn look_in_dir(dir: &Path, stem: &str) -> Option<PathBuf> {
    for name in sidecar_candidate_names(stem) {
        let candidate = dir.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn sidecar_candidate_names(stem: &str) -> Vec<String> {
    let mut names = vec![sidecar_file_name(stem)];
    if let Some(triple) = option_env!("OMNIPANEL_TARGET_TRIPLE") {
        if !triple.is_empty() {
            names.push(sidecar_file_name(&format!("{stem}-{triple}")));
        }
    }
    names
}

fn search_sidecar_binary(kind: EngineKind, plugins_root: Option<&Path>) -> Option<PathBuf> {
    let stem = kind.bin_stem();
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            if dir.file_name().and_then(|n| n.to_str()) == Some("deps") {
                if let Some(parent) = dir.parent() {
                    dirs.push(parent.to_path_buf());
                }
            }
            dirs.push(dir.join("binaries"));
        }
    }
    if let Some(workspace) = find_workspace_root() {
        let target = cargo_target_dir(&workspace);
        dirs.push(target.join("debug"));
        dirs.push(target.join("release"));
        if let Some(triple) = option_env!("OMNIPANEL_TARGET_TRIPLE") {
            if !triple.is_empty() {
                dirs.push(target.join(triple).join("debug"));
                dirs.push(target.join(triple).join("release"));
            }
        }
        dirs.push(workspace.join("src-tauri").join("binaries"));
        dirs.push(
            workspace
                .join("plugins")
                .join(kind.plugin_folder())
                .join("bin"),
        );
    }
    if let Some(root) = plugins_root {
        dirs.push(root.join(kind.plugin_id()).join("bin"));
    }

    for dir in dirs {
        if let Some(found) = look_in_dir(&dir, stem) {
            return Some(found);
        }
    }
    None
}

fn running_as_host_app() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem()?.to_str().map(|s| s.to_ascii_lowercase()))
        .is_some_and(|name| name == "omnipanel-app" || name == "omnipanel")
}

fn ensure_dev_sidecar_built(kind: EngineKind) {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !dev_sidecar_needs_rebuild(kind) {
        return;
    }
    if let Err(err) = try_build_dev_sidecar(kind) {
        tracing::warn!("{} sidecar 自动编译失败: {err}", kind.as_str());
    }
}

fn dev_sidecar_needs_rebuild(kind: EngineKind) -> bool {
    let Some(workspace) = find_workspace_root() else {
        return true;
    };
    let binary = cargo_target_dir(&workspace)
        .join("debug")
        .join(sidecar_file_name(kind.bin_stem()));
    let Ok(bin_meta) = binary.metadata() else {
        return true;
    };
    let Ok(bin_mtime) = bin_meta.modified() else {
        return true;
    };
    let engine_crate = format!("crates/{}", kind.crate_name());
    for rel in ["crates/omnipanel-db", "crates/omnipanel-error", &engine_crate] {
        let dir = workspace.join(rel);
        if let Some(src_mtime) = newest_source_mtime(&dir) {
            if src_mtime > bin_mtime {
                return true;
            }
        } else if !dir.is_dir() {
            continue;
        }
    }
    false
}

fn newest_source_mtime(root: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    fn visit(path: &Path, newest: &mut Option<SystemTime>) {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name == "target" || name == ".git" {
                continue;
            }
            if path.is_dir() {
                visit(&path, newest);
                continue;
            }
            let Some(name) = name.to_str() else {
                continue;
            };
            if !(name.ends_with(".rs") || name == "Cargo.toml") {
                continue;
            }
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                *newest = Some(match *newest {
                    Some(prev) => prev.max(modified),
                    None => modified,
                });
            }
        }
    }
    visit(root, &mut newest);
    newest
}

fn try_build_dev_sidecar(kind: EngineKind) -> OmniResult<()> {
    let Some(workspace) = find_workspace_root() else {
        return Err(OmniError::not_found(
            "开发期未定位到仓库根目录，无法自动编译 sidecar",
        ));
    };
    let package = kind.crate_name();
    tracing::info!("正在编译 sidecar {package}");
    let status = std::process::Command::new("cargo")
        .current_dir(&workspace)
        .args(["build", "-p", package])
        .status()
        .map_err(|e| {
            OmniError::connection(format!("无法启动 cargo 编译 {package}")).with_cause(e.to_string())
        })?;
    if !status.success() {
        return Err(OmniError::connection(format!(
            "编译 sidecar 失败（cargo build -p {package}）"
        )));
    }
    Ok(())
}

pub async fn invoke_json<T: serde::de::DeserializeOwned>(
    kind: EngineKind,
    params: &DbParams,
    method: &str,
    args: Value,
) -> OmniResult<T> {
    connect_engine(kind, params)
        .await?
        .rpc_parse(method, args)
        .await
}

pub async fn invoke_query(
    kind: EngineKind,
    params: &DbParams,
    method: &str,
    args: Value,
) -> OmniResult<QueryResult> {
    let value = connect_engine(kind, params)
        .await?
        .invoke(method, args)
        .await?;
    decode_query_result(value).map_err(OmniError::database)
}

fn find_workspace_root() -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    for start in starts {
        let mut dir = start;
        loop {
            let manifest = dir.join("Cargo.toml");
            if manifest.is_file() {
                if let Ok(text) = std::fs::read_to_string(&manifest) {
                    if text.contains("[workspace]") && dir.join("src-tauri").is_dir() {
                        return Some(dir);
                    }
                }
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

fn cargo_target_dir(workspace: &Path) -> PathBuf {
    match std::env::var("CARGO_TARGET_DIR") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                path
            } else {
                workspace.join(path)
            }
        }
        _ => workspace.join("target"),
    }
}

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use omnipanel_ssh::{SshSession, StreamChunk};
use omnipanel_store::{DbConnectionConfig, fill_db_password_from_vault};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::event::{BgTaskMysqlExportEvent, MysqlExportEventSink, MysqlExportRecord};
use crate::paths::connection_exports_dir;

type ProgressCb = Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>;

/// SSH 会话提供者（由宿主实现，例如 Tauri `SshPool`）。
#[async_trait]
pub trait SshSessionProvider: Send + Sync {
    async fn ensure_session(&self, id: &str) -> Result<Arc<SshSession>, String>;
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MysqlExportDeployment {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    /// Docker 容器内 MySQL 监听端口（勿填宿主机 publish 端口）。缺省 3306。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mysql_port: Option<u16>,
    /// 为 true 时使用 `--databases`（SQL 含 CREATE DATABASE / USE）。
    /// 导出到其它库时应为 false，以便导入到用户指定的目标库名。
    #[serde(default = "default_true")]
    pub include_create_database: bool,
}

fn default_true() -> bool {
    true
}

fn meta_path_for(base_dir: &Path, export_id: &str) -> PathBuf {
    base_dir.join(format!("{export_id}.json"))
}

fn sql_path_for(base_dir: &Path, export_id: &str) -> PathBuf {
    base_dir.join(format!("{export_id}.sql"))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn write_record(base_dir: &Path, record: &MysqlExportRecord) -> Result<(), String> {
    let meta_path = meta_path_for(base_dir, &record.id);
    let json =
        serde_json::to_string_pretty(record).map_err(|e| format!("序列化导出记录失败: {e}"))?;
    fs::write(meta_path, json).map_err(|e| format!("写入导出记录失败: {e}"))
}

fn read_record(base_dir: &Path, export_id: &str) -> Result<MysqlExportRecord, String> {
    let meta_path = meta_path_for(base_dir, export_id);
    let raw = fs::read_to_string(&meta_path).map_err(|e| format!("读取导出记录失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析导出记录失败: {e}"))
}

fn refresh_record_size(base_dir: &Path, record: &mut MysqlExportRecord) {
    let sql_path = base_dir.join(&record.file_name);
    if sql_path.is_file() {
        if let Ok(meta) = fs::metadata(&sql_path) {
            record.file_size = meta.len();
        }
        record.file_path = sql_path.to_string_lossy().into_owned();
    }
}

pub fn list_mysql_exports(connection_id: &str) -> Result<Vec<MysqlExportRecord>, String> {
    let base_dir = connection_exports_dir(connection_id)?;
    if !base_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut records = Vec::new();
    for entry in fs::read_dir(&base_dir).map_err(|e| format!("读取导出目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取导出条目失败: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取导出记录失败: {e}"))?;
        let mut record: MysqlExportRecord =
            serde_json::from_str(&raw).map_err(|e| format!("解析导出记录失败: {e}"))?;
        refresh_record_size(&base_dir, &mut record);
        records.push(record);
    }

    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(records)
}

pub fn resolve_export_record(
    connection_id: &str,
    export_id: &str,
) -> Result<MysqlExportRecord, String> {
    let base_dir = connection_exports_dir(connection_id)?;
    let mut record = read_record(&base_dir, export_id)?;
    refresh_record_size(&base_dir, &mut record);
    Ok(record)
}

/// 删除导出记录及其 SQL / 临时配置文件（若存在）。
pub fn delete_mysql_export(connection_id: &str, export_id: &str) -> Result<(), String> {
    let base_dir = connection_exports_dir(connection_id)?;
    let record = read_record(&base_dir, export_id)?;
    if record.status == "running" {
        return Err("导出进行中，无法删除".to_string());
    }

    let base_canonical = base_dir.canonicalize().unwrap_or_else(|_| base_dir.clone());
    let remove_if_under_base = |path: &Path| -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("导出文件无法访问: {e}"))?;
        if !canonical.starts_with(&base_canonical) {
            return Err("不允许删除该导出文件".to_string());
        }
        fs::remove_file(&canonical).map_err(|e| format!("删除导出文件失败: {e}"))
    };

    remove_if_under_base(&sql_path_for(&base_dir, export_id))?;
    // 兼容历史路径或自定义 file_path
    if !record.file_path.is_empty() {
        let custom = PathBuf::from(&record.file_path);
        if custom != sql_path_for(&base_dir, export_id) {
            let _ = remove_if_under_base(&custom);
        }
    }
    let _ = fs::remove_file(sql_path_for(&base_dir, export_id).with_extension("cnf"));
    remove_if_under_base(&meta_path_for(&base_dir, export_id))?;
    Ok(())
}

pub fn copy_mysql_export_file(
    connection_id: &str,
    export_id: &str,
    dest_path: &str,
) -> Result<String, String> {
    if dest_path.trim().is_empty() {
        return Err("未指定目标路径".to_string());
    }
    let record = resolve_export_record(connection_id, export_id)?;
    let source = PathBuf::from(&record.file_path);
    if !source.is_file() {
        return Err("导出文件不存在".to_string());
    }
    let base_dir = connection_exports_dir(connection_id)?;
    let base_canonical = base_dir.canonicalize().unwrap_or(base_dir);
    let source_canonical = source
        .canonicalize()
        .map_err(|e| format!("导出文件无法访问: {e}"))?;
    if !source_canonical.starts_with(&base_canonical) {
        return Err("不允许复制该导出文件".to_string());
    }
    let dest = PathBuf::from(dest_path);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {e}"))?;
        }
    }
    fs::copy(&source_canonical, &dest).map_err(|e| format!("复制导出文件失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "" | "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

/// 宿主机 mysqldump/mysql 连接地址：非环回地址用连接配置里的真实 host，避免误连本机 127.0.0.1。
fn remote_mysql_cli_host(connection: &DbConnectionConfig) -> &str {
    let host = connection.host.trim();
    if is_loopback_host(host) {
        "127.0.0.1"
    } else {
        host
    }
}

fn cnf_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn sanitize_db_name(name: &str) -> Result<String, String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("数据库名称无效".to_string());
    }
    Ok(name.to_string())
}

fn mysqldump_db_target(database_name: &str, include_create_database: bool) -> String {
    let db = shell_single_quote(database_name);
    if include_create_database {
        format!("--databases {db}")
    } else {
        db
    }
}

fn build_mysqldump_shell_with_defaults(
    defaults_file: &str,
    database_name: &str,
    include_create_database: bool,
) -> String {
    format!(
        "mysqldump --defaults-extra-file={defaults} --verbose --single-transaction --routines --triggers --events --set-gtid-purged=OFF {target}",
        defaults = shell_single_quote(defaults_file),
        target = mysqldump_db_target(database_name, include_create_database),
    )
}

/// 容器内 mysqldump 使用的端口：优先部署信息，缺省 3306。
/// 注意：不可使用连接配置里的 host publish 端口（如 13306）。
fn resolve_docker_mysql_port(deployment: &MysqlExportDeployment) -> u16 {
    deployment.mysql_port.filter(|p| *p > 0).unwrap_or(3306)
}

fn build_docker_mysqldump_shell(
    connection: &DbConnectionConfig,
    database_name: &str,
    mysql_port: u16,
    include_create_database: bool,
) -> String {
    // docker exec 已 `-e MYSQL_PWD=...`。单独 `-p` 会提示 Enter password，并忽略 MYSQL_PWD
    // （1045 using password: NO）。容器内 sh 展开 $MYSQL_PWD；外层单引号避免宿主机展开。
    format!(
        "mysqldump -h127.0.0.1 -P{port} -u{user} --password=\"$MYSQL_PWD\" --verbose --single-transaction --routines --triggers --events --set-gtid-purged=OFF {target}",
        port = mysql_port,
        user = shell_single_quote(&connection.user),
        target = mysqldump_db_target(database_name, include_create_database),
    )
}

/// 从 mysqldump --verbose 行中解析当前表名。
fn parse_mysqldump_table_from_verbose(line: &str) -> Option<String> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("-- Retrieving table structure for table ") {
        let name = rest
            .split("...")
            .next()
            .unwrap_or(rest)
            .trim()
            .trim_matches('`');
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    if let Some(rest) = line.strip_prefix("-- Dumping data for table ") {
        let name = rest.trim().trim_matches('`');
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

fn is_mysqldump_routines_phase(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    line.contains("dumping routines")
        || line.contains("dumping events")
        || line.contains("dumping triggers")
}

struct MysqldumpProgressTracker {
    database_name: String,
    table_total: Option<u32>,
    seen_tables: HashSet<String>,
}

impl MysqldumpProgressTracker {
    fn new(database_name: impl Into<String>, table_total: Option<u32>) -> Self {
        Self {
            database_name: database_name.into(),
            table_total,
            seen_tables: HashSet::new(),
        }
    }

    fn on_stderr_line(&mut self, line: &str, progress: &ProgressCb) {
        if let Some(table) = parse_mysqldump_table_from_verbose(line) {
            self.seen_tables.insert(table.clone());
            let done = self.seen_tables.len() as u32;
            let total = self.table_total.unwrap_or(done).max(done).max(1);
            progress(
                format!(
                    "正在导出 `{db}`.`{table}`（{done}/{total}）",
                    db = self.database_name
                ),
                done,
                total,
                Some(done),
                Some(total),
            );
            return;
        }
        if is_mysqldump_routines_phase(line) {
            let done = self.seen_tables.len() as u32;
            let total = self.table_total.unwrap_or(done).max(done).max(1);
            progress(
                format!("正在导出 `{db}` 的例程/事件…", db = self.database_name),
                done,
                total,
                Some(done),
                Some(total),
            );
        }
    }
}

fn feed_stderr_chunk(
    buf: &mut String,
    chunk: &str,
    tracker: &mut MysqldumpProgressTracker,
    progress: &ProgressCb,
) {
    buf.push_str(chunk);
    while let Some(pos) = buf.find('\n') {
        let mut line = buf[..pos].to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        tracker.on_stderr_line(&line, progress);
        buf.drain(..=pos);
    }
}

async fn count_base_tables_local(
    connection: &DbConnectionConfig,
    database_name: &str,
) -> Option<u32> {
    let defaults_path = std::env::temp_dir().join(format!(
        "omnipanel-count-{}.cnf",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let defaults = build_defaults_file_content(connection, &connection.host, connection.port);
    fs::write(&defaults_path, defaults).ok()?;
    let sql = format!(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{database_name}' AND table_type='BASE TABLE'"
    );
    let output = tokio::process::Command::new("mysql")
        .arg(format!("--defaults-extra-file={}", defaults_path.display()))
        .arg("-N")
        .arg("-e")
        .arg(&sql)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok();
    let _ = fs::remove_file(&defaults_path);
    let output = output?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find_map(|line| line.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
}

fn build_defaults_file_content(connection: &DbConnectionConfig, host: &str, port: u16) -> String {
    format!(
        "[client]\nuser={}\npassword={}\nhost={}\nport={}\n",
        cnf_quote(&connection.user),
        cnf_quote(&connection.password),
        cnf_quote(host),
        port
    )
}

async fn emit_export_event(sink: &dyn MysqlExportEventSink, event: BgTaskMysqlExportEvent) {
    sink.emit_export_event(event).await;
}

async fn run_local_mysqldump(
    connection: &DbConnectionConfig,
    database_name: &str,
    output_path: &Path,
    include_create_database: bool,
    cancel: &Arc<AtomicBool>,
    progress: &ProgressCb,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    let table_total = count_base_tables_local(connection, database_name).await;
    let mut tracker = MysqldumpProgressTracker::new(database_name, table_total);
    if let Some(total) = table_total {
        progress(
            format!("准备导出 `{database_name}`（共 {total} 张表）…"),
            0,
            total.max(1),
            Some(0),
            Some(total),
        );
    }

    let defaults_path = output_path.with_extension("cnf");
    let defaults_content =
        build_defaults_file_content(connection, &connection.host, connection.port);
    fs::write(&defaults_path, defaults_content)
        .map_err(|e| format!("写入 mysqldump 配置失败: {e}"))?;

    let stdout_file =
        fs::File::create(output_path).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut dump_cmd = tokio::process::Command::new("mysqldump");
    dump_cmd
        .arg(format!("--defaults-extra-file={}", defaults_path.display()))
        .arg("--verbose")
        .arg("--single-transaction")
        .arg("--routines")
        .arg("--triggers")
        .arg("--events")
        .arg("--set-gtid-purged=OFF");
    if include_create_database {
        dump_cmd.arg("--databases");
    }
    let mut child = dump_cmd
        .arg(database_name)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 mysqldump 失败: {e}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 mysqldump stderr".to_string())?;
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    let mut stderr_log = String::new();

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = fs::remove_file(output_path);
            let _ = fs::remove_file(&defaults_path);
            return Err("任务已取消".to_string());
        }
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                stderr_log.push_str(&line);
                tracker.on_stderr_line(&line, progress);
            }
            Err(e) => {
                let _ = child.kill().await;
                let _ = fs::remove_file(output_path);
                let _ = fs::remove_file(&defaults_path);
                return Err(format!("读取 mysqldump 进度失败: {e}"));
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("等待 mysqldump 退出失败: {e}"))?;
    let _ = fs::remove_file(&defaults_path);

    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(output_path);
        return Err("任务已取消".to_string());
    }
    if !status.success() {
        let _ = fs::remove_file(output_path);
        return Err(if stderr_log.trim().is_empty() {
            format!("mysqldump 退出码 {}", status.code().unwrap_or(-1))
        } else {
            // 取末尾错误行，避免 verbose 日志淹没真正原因
            stderr_log
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with("-- "))
                .unwrap_or(stderr_log.trim())
                .trim()
                .to_string()
        });
    }
    Ok(())
}

async fn count_base_tables_remote(
    session: &omnipanel_ssh::SshSession,
    connection: &DbConnectionConfig,
    deployment: &MysqlExportDeployment,
    database_name: &str,
) -> Option<u32> {
    let sql = format!(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{database_name}' AND table_type='BASE TABLE'"
    );
    let cmd = if deployment.kind == "docker" {
        let container_id = deployment.container_id.as_deref()?;
        let mysql_port = resolve_docker_mysql_port(deployment);
        format!(
            "docker exec -e MYSQL_PWD={} {} sh -c {}",
            shell_single_quote(&connection.password),
            shell_single_quote(container_id),
            shell_single_quote(&format!(
                "mysql -h127.0.0.1 -P{mysql_port} -u{} --password=\"$MYSQL_PWD\" -N -e {}",
                shell_single_quote(&connection.user),
                shell_single_quote(&sql),
            )),
        )
    } else {
        let defaults = build_defaults_file_content(
            connection,
            remote_mysql_cli_host(connection),
            connection.port,
        );
        let remote_cnf = format!("/tmp/omnipanel-count-{}.cnf", now_millis());
        let write = format!(
            "cat > {} <<'OMNI_EOF'\n{}\nOMNI_EOF\nchmod 600 {}",
            shell_single_quote(&remote_cnf),
            defaults.trim_end(),
            shell_single_quote(&remote_cnf),
        );
        let _ = session.exec_capture(&write).await.ok()?;
        let cmd = format!(
            "mysql --defaults-extra-file={} -N -e {}; rm -f {}",
            shell_single_quote(&remote_cnf),
            shell_single_quote(&sql),
            shell_single_quote(&remote_cnf),
        );
        let output = session.exec_capture(&cmd).await.ok()?;
        if output.exit_code != 0 {
            return None;
        }
        return output
            .stdout
            .lines()
            .find_map(|line| line.trim().parse::<u32>().ok())
            .filter(|n| *n > 0);
    };
    let output = session.exec_capture(&cmd).await.ok()?;
    if output.exit_code != 0 {
        return None;
    }
    output
        .stdout
        .lines()
        .find_map(|line| line.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
}

async fn run_remote_mysqldump(
    ssh: &dyn SshSessionProvider,
    ssh_connection_id: &str,
    connection: &DbConnectionConfig,
    database_name: &str,
    deployment: &MysqlExportDeployment,
    output_path: &Path,
    export_id: &str,
    include_create_database: bool,
    cancel: &Arc<AtomicBool>,
    progress: &ProgressCb,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    let session = ssh
        .ensure_session(ssh_connection_id)
        .await
        .map_err(|e| format!("SSH 连接失败: {e}"))?;

    let table_total =
        count_base_tables_remote(&session, connection, deployment, database_name).await;
    let mut tracker = MysqldumpProgressTracker::new(database_name, table_total);
    if let Some(total) = table_total {
        progress(
            format!("准备导出 `{database_name}`（共 {total} 张表）…"),
            0,
            total.max(1),
            Some(0),
            Some(total),
        );
    }

    let remote_defaults = format!("/tmp/omnipanel-export-{export_id}.cnf");
    let remote_sql = format!("/tmp/omnipanel-export-{export_id}.sql");
    // 宿主机 mysqldump：库不在 SSH 本机时用连接配置的真实 host，勿写死 127.0.0.1。
    // 容器内 mysqldump：必须用容器内监听端口，见 resolve_docker_mysql_port。
    let defaults_content = build_defaults_file_content(
        connection,
        remote_mysql_cli_host(connection),
        connection.port,
    );
    let write_defaults = if deployment.kind == "docker" {
        String::new()
    } else {
        format!(
            "cat > {} <<'OMNI_EOF'\n{}\nOMNI_EOF\nchmod 600 {}",
            shell_single_quote(&remote_defaults),
            defaults_content.trim_end(),
            shell_single_quote(&remote_defaults),
        )
    };
    if !write_defaults.is_empty() {
        session
            .exec_capture(&write_defaults)
            .await
            .map_err(|e| format!("写入远端 mysqldump 配置失败: {e}"))?;
    }

    let dump_cmd = if deployment.kind == "docker" {
        let container_id = deployment
            .container_id
            .as_deref()
            .ok_or_else(|| "缺少 Docker 容器 ID".to_string())?;
        let mysql_port = resolve_docker_mysql_port(deployment);
        format!(
            "docker exec -e MYSQL_PWD={} {} sh -c {} > {}",
            shell_single_quote(&connection.password),
            shell_single_quote(container_id),
            shell_single_quote(&build_docker_mysqldump_shell(
                connection,
                database_name,
                mysql_port,
                include_create_database,
            )),
            shell_single_quote(&remote_sql),
        )
    } else {
        format!(
            "{} > {}",
            build_mysqldump_shell_with_defaults(
                &remote_defaults,
                database_name,
                include_create_database,
            ),
            shell_single_quote(&remote_sql),
        )
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<StreamChunk>();
    let mut handle = session
        .exec_stream(&dump_cmd, tx)
        .await
        .map_err(|e| format!("远端 mysqldump 执行失败: {e}"))?;

    let mut line_buf = String::new();
    let mut stderr_log = String::new();
    let mut exit_code: i32 = -1;

    loop {
        if cancel.load(Ordering::Relaxed) {
            handle.signal_stop();
            handle.stop().await;
            let _ = session.exec_capture(&format!(
                "rm -f {} {}",
                shell_single_quote(&remote_sql),
                shell_single_quote(&remote_defaults)
            ));
            return Err("任务已取消".to_string());
        }
        match rx.recv().await {
            Some(StreamChunk::Stdout(_)) => {}
            Some(StreamChunk::Stderr(bytes)) => {
                let chunk = String::from_utf8_lossy(&bytes);
                stderr_log.push_str(&chunk);
                feed_stderr_chunk(&mut line_buf, &chunk, &mut tracker, progress);
            }
            Some(StreamChunk::Exit(code)) => {
                exit_code = code;
            }
            Some(StreamChunk::Closed) | None => {
                if !line_buf.is_empty() {
                    tracker.on_stderr_line(&line_buf, progress);
                    line_buf.clear();
                }
                break;
            }
        }
    }
    handle.stop().await;

    if deployment.kind != "docker" {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_defaults)));
    }

    if cancel.load(Ordering::Relaxed) {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_sql)));
        return Err("任务已取消".to_string());
    }
    if exit_code != 0 {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_sql)));
        let detail = stderr_log
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with("-- "))
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        return Err(if detail.is_empty() {
            format!("远端 mysqldump 失败，退出码 {exit_code}")
        } else {
            detail
        });
    }

    progress(
        format!("正在下载导出文件…"),
        tracker.seen_tables.len() as u32,
        tracker
            .table_total
            .unwrap_or(tracker.seen_tables.len() as u32)
            .max(1),
        Some(tracker.seen_tables.len() as u32),
        tracker.table_total,
    );

    let bytes = session
        .sftp_download(&remote_sql)
        .await
        .map_err(|e| format!("下载导出文件失败: {e}"))?;
    let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_sql)));

    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    fs::write(output_path, bytes).map_err(|e| format!("写入本地导出文件失败: {e}"))?;
    Ok(())
}

/// 将导出记录标记为失败并落盘、发事件；始终返回 `Err(error)` 供后台任务汇总。
async fn mark_export_failed(
    sink: &dyn MysqlExportEventSink,
    base_dir: &Path,
    record: &mut MysqlExportRecord,
    task_id: String,
    error: String,
) -> Result<(), String> {
    let _ = fs::remove_file(sql_path_for(base_dir, &record.id));
    record.status = "failed".to_string();
    record.error = Some(error.clone());
    // 失败记录必须尽量落盘，避免列表里看不到失败历史
    if let Err(write_err) = write_record(base_dir, record) {
        emit_export_event(
            sink,
            BgTaskMysqlExportEvent {
                task_id: task_id.clone(),
                event_type: "failed".to_string(),
                connection_id: record.connection_id.clone(),
                export: Some(record.clone()),
                error: Some(format!("{error}（且写入导出记录失败: {write_err}）")),
            },
        )
        .await;
        return Err(format!("{error}（且写入导出记录失败: {write_err}）"));
    }
    emit_export_event(
        sink,
        BgTaskMysqlExportEvent {
            task_id,
            event_type: "failed".to_string(),
            connection_id: record.connection_id.clone(),
            export: Some(record.clone()),
            error: Some(error.clone()),
        },
    )
    .await;
    Err(error)
}

/// 在尚未进入 dump 前失败时仍写入一条 failed 记录（例如库名非法）。
async fn persist_early_export_failure(
    sink: &dyn MysqlExportEventSink,
    connection_id: &str,
    database_name: &str,
    task_id: &str,
    error: String,
) -> Result<(), String> {
    let base_dir = match connection_exports_dir(connection_id) {
        Ok(dir) => dir,
        Err(dir_err) => {
            emit_export_event(
                sink,
                BgTaskMysqlExportEvent {
                    task_id: task_id.to_string(),
                    event_type: "failed".to_string(),
                    connection_id: connection_id.to_string(),
                    export: None,
                    error: Some(format!("{error}；{dir_err}")),
                },
            )
            .await;
            return Err(format!("{error}；{dir_err}"));
        }
    };
    let export_id = format!("export-{}", now_millis());
    let mut record = MysqlExportRecord {
        id: export_id.clone(),
        connection_id: connection_id.to_string(),
        database_name: database_name.to_string(),
        file_name: format!("{export_id}.sql"),
        file_path: sql_path_for(&base_dir, &export_id)
            .to_string_lossy()
            .into_owned(),
        created_at: now_millis(),
        file_size: 0,
        status: "failed".to_string(),
        error: Some(error.clone()),
        task_id: Some(task_id.to_string()),
    };
    mark_export_failed(sink, &base_dir, &mut record, task_id.to_string(), error).await
}

pub async fn run_mysql_export(
    sink: Arc<dyn MysqlExportEventSink>,
    ssh: Arc<dyn SshSessionProvider>,
    task_id: String,
    mut connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    fill_db_password_from_vault(&mut connection);
    if connection.password.trim().is_empty() && connection.has_password {
        return persist_early_export_failure(
            sink.as_ref(),
            &connection.id,
            &database_name,
            &task_id,
            "无法从钥匙串读取数据库密码，请重新保存该连接的密码后再导出".to_string(),
        )
        .await;
    }
    let raw_database_name = database_name.clone();
    let database_name = match sanitize_db_name(&database_name) {
        Ok(name) => name,
        Err(error) => {
            return persist_early_export_failure(
                sink.as_ref(),
                &connection.id,
                &raw_database_name,
                &task_id,
                error,
            )
            .await;
        }
    };

    let base_dir = match connection_exports_dir(&connection.id) {
        Ok(dir) => dir,
        Err(error) => {
            // 目录都建不出来时无法落盘 meta，仍发事件把原因交给前端
            emit_export_event(
                sink.as_ref(),
                BgTaskMysqlExportEvent {
                    task_id: task_id.clone(),
                    event_type: "failed".to_string(),
                    connection_id: connection.id.clone(),
                    export: None,
                    error: Some(error.clone()),
                },
            )
            .await;
            return Err(error);
        }
    };

    let export_id = format!("export-{}", now_millis());
    let file_name = format!("{export_id}.sql");
    let output_path = sql_path_for(&base_dir, &export_id);
    let created_at = now_millis();

    let mut record = MysqlExportRecord {
        id: export_id.clone(),
        connection_id: connection.id.clone(),
        database_name: database_name.clone(),
        file_name: file_name.clone(),
        file_path: output_path.to_string_lossy().into_owned(),
        created_at,
        file_size: 0,
        status: "running".to_string(),
        error: None,
        task_id: Some(task_id.clone()),
    };
    if let Err(error) = write_record(&base_dir, &record) {
        return persist_early_export_failure(
            sink.as_ref(),
            &connection.id,
            &database_name,
            &task_id,
            error,
        )
        .await;
    }
    emit_export_event(
        sink.as_ref(),
        BgTaskMysqlExportEvent {
            task_id: task_id.clone(),
            event_type: "started".to_string(),
            connection_id: connection.id.clone(),
            export: Some(record.clone()),
            error: None,
        },
    )
    .await;

    progress(format!("正在导出数据库 {database_name}…"), 0, 1, None, None);

    // 用 async 块承接部署侧前置错误，避免 `?` 提前返回导致 running 记录无法落成 failed
    let dump_result = async {
        if deployment.kind == "host" || deployment.kind == "docker" {
            let ssh_id = deployment
                .ssh_connection_id
                .as_deref()
                .ok_or_else(|| "缺少 SSH 连接".to_string())?;
            run_remote_mysqldump(
                ssh.as_ref(),
                ssh_id,
                &connection,
                &database_name,
                &deployment,
                &output_path,
                &export_id,
                deployment.include_create_database,
                &cancel,
                &progress,
            )
            .await
        } else {
            run_local_mysqldump(
                &connection,
                &database_name,
                &output_path,
                deployment.include_create_database,
                &cancel,
                &progress,
            )
            .await
        }
    }
    .await;

    match dump_result {
        Ok(()) => {
            refresh_record_size(&base_dir, &mut record);
            record.status = "completed".to_string();
            write_record(&base_dir, &record)?;
            progress(format!("导出完成：{database_name}"), 1, 1, None, None);
            emit_export_event(
                sink.as_ref(),
                BgTaskMysqlExportEvent {
                    task_id: task_id.clone(),
                    event_type: "completed".to_string(),
                    connection_id: connection.id.clone(),
                    export: Some(record),
                    error: None,
                },
            )
            .await;
            Ok(())
        }
        Err(error) => {
            mark_export_failed(sink.as_ref(), &base_dir, &mut record, task_id, error).await
        }
    }
}

/// 导入 SQL 来源：本地文件或本连接已完成的导出记录。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MysqlImportSource {
    /// `file` | `export`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_id: Option<String>,
}

fn resolve_import_sql_path(
    connection_id: &str,
    source: &MysqlImportSource,
) -> Result<PathBuf, String> {
    match source.kind.as_str() {
        "file" => {
            let path = source
                .file_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "未指定 SQL 文件路径".to_string())?;
            let path = PathBuf::from(path);
            if !path.is_file() {
                return Err("SQL 文件不存在".to_string());
            }
            Ok(path)
        }
        "export" => {
            let export_id = source
                .export_id
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "未指定导出记录".to_string())?;
            let record = resolve_export_record(connection_id, export_id)?;
            if record.status != "completed" {
                return Err("仅可导入已完成的导出记录".to_string());
            }
            let path = PathBuf::from(&record.file_path);
            if !path.is_file() {
                return Err("导出 SQL 文件不存在".to_string());
            }
            Ok(path)
        }
        _ => Err("不支持的导入来源".to_string()),
    }
}

fn build_docker_mysql_client_shell(
    connection: &DbConnectionConfig,
    mysql_port: u16,
    database_name: &str,
) -> String {
    format!(
        "mysql -h127.0.0.1 -P{port} -u{user} --password=\"$MYSQL_PWD\" {db}",
        port = mysql_port,
        user = shell_single_quote(&connection.user),
        db = shell_single_quote(database_name),
    )
}

fn build_mysql_client_shell_with_defaults(defaults_file: &str, database_name: &str) -> String {
    format!(
        "mysql --defaults-extra-file={defaults} {db}",
        defaults = shell_single_quote(defaults_file),
        db = shell_single_quote(database_name),
    )
}

async fn run_local_mysql_import(
    connection: &DbConnectionConfig,
    database_name: &str,
    sql_path: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    let defaults_path = sql_path.with_extension("import.cnf");
    let defaults_content =
        build_defaults_file_content(connection, &connection.host, connection.port);
    fs::write(&defaults_path, defaults_content).map_err(|e| format!("写入 mysql 配置失败: {e}"))?;

    let sql_file = fs::File::open(sql_path).map_err(|e| format!("打开 SQL 文件失败: {e}"))?;
    let mut command = tokio::process::Command::new("mysql");
    command
        .arg(format!("--defaults-extra-file={}", defaults_path.display()))
        .arg(database_name)
        .stdin(std::process::Stdio::from(sql_file))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let output = command
        .output()
        .await
        .map_err(|e| format!("启动 mysql 失败: {e}"))?;
    let _ = fs::remove_file(&defaults_path);

    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("mysql 退出码 {}", output.status.code().unwrap_or(-1))
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(())
}

async fn run_remote_mysql_import(
    ssh: &dyn SshSessionProvider,
    ssh_connection_id: &str,
    connection: &DbConnectionConfig,
    deployment: &MysqlExportDeployment,
    database_name: &str,
    sql_path: &Path,
    import_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    let session = ssh
        .ensure_session(ssh_connection_id)
        .await
        .map_err(|e| format!("SSH 连接失败: {e}"))?;

    let bytes = fs::read(sql_path).map_err(|e| format!("读取 SQL 文件失败: {e}"))?;
    let remote_sql = format!("/tmp/omnipanel-import-{import_id}.sql");
    let remote_defaults = format!("/tmp/omnipanel-import-{import_id}.cnf");

    session
        .sftp_upload(&remote_sql, &bytes)
        .await
        .map_err(|e| format!("上传 SQL 文件失败: {e}"))?;

    if cancel.load(Ordering::Relaxed) {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_sql)));
        return Err("任务已取消".to_string());
    }

    let import_cmd = if deployment.kind == "docker" {
        let container_id = deployment
            .container_id
            .as_deref()
            .ok_or_else(|| "缺少 Docker 容器 ID".to_string())?;
        let mysql_port = resolve_docker_mysql_port(deployment);
        format!(
            "docker exec -i -e MYSQL_PWD={} {} sh -c {} < {}",
            shell_single_quote(&connection.password),
            shell_single_quote(container_id),
            shell_single_quote(&build_docker_mysql_client_shell(
                connection,
                mysql_port,
                database_name,
            )),
            shell_single_quote(&remote_sql),
        )
    } else {
        let defaults_content = build_defaults_file_content(
            connection,
            remote_mysql_cli_host(connection),
            connection.port,
        );
        let write_defaults = format!(
            "cat > {} <<'OMNI_EOF'\n{}\nOMNI_EOF\nchmod 600 {}",
            shell_single_quote(&remote_defaults),
            defaults_content.trim_end(),
            shell_single_quote(&remote_defaults),
        );
        session
            .exec_capture(&write_defaults)
            .await
            .map_err(|e| format!("写入远端 mysql 配置失败: {e}"))?;
        format!(
            "{} < {}",
            build_mysql_client_shell_with_defaults(&remote_defaults, database_name),
            shell_single_quote(&remote_sql),
        )
    };

    let import_output = session
        .exec_capture(&import_cmd)
        .await
        .map_err(|e| format!("远端 mysql 导入失败: {e}"))?;

    let _ = session.exec_capture(&format!(
        "rm -f {} {}",
        shell_single_quote(&remote_sql),
        shell_single_quote(&remote_defaults),
    ));

    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    if import_output.exit_code != 0 {
        let detail = if import_output.stderr.trim().is_empty() {
            import_output.stdout.trim().to_string()
        } else {
            import_output.stderr.trim().to_string()
        };
        return Err(if detail.is_empty() {
            format!("远端 mysql 导入失败，退出码 {}", import_output.exit_code)
        } else {
            detail
        });
    }
    Ok(())
}

/// 执行 MySQL SQL 导入（对称导出的 local / host / docker 路径）。
pub async fn run_mysql_import(
    _sink: Arc<dyn MysqlExportEventSink>,
    ssh: Arc<dyn SshSessionProvider>,
    task_id: String,
    mut connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
    source: MysqlImportSource,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    fill_db_password_from_vault(&mut connection);
    if connection.password.trim().is_empty() && connection.has_password {
        return Err("无法从钥匙串读取数据库密码，请重新保存该连接的密码后再导入".to_string());
    }
    let _ = task_id;
    let database_name = sanitize_db_name(&database_name)?;
    let sql_path = resolve_import_sql_path(&connection.id, &source)?;
    let import_id = format!("import-{}", now_millis());

    progress(
        format!("正在导入 SQL 到 {database_name}…"),
        0,
        1,
        None,
        None,
    );

    let result = async {
        if deployment.kind == "host" || deployment.kind == "docker" {
            let ssh_id = deployment
                .ssh_connection_id
                .as_deref()
                .ok_or_else(|| "缺少 SSH 连接".to_string())?;
            run_remote_mysql_import(
                ssh.as_ref(),
                ssh_id,
                &connection,
                &deployment,
                &database_name,
                &sql_path,
                &import_id,
                &cancel,
            )
            .await
        } else {
            run_local_mysql_import(&connection, &database_name, &sql_path, &cancel).await
        }
    }
    .await;

    match result {
        Ok(()) => {
            progress(format!("导入完成：{database_name}"), 1, 1, None, None);
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_conn(host: &str, user: &str, password: &str) -> DbConnectionConfig {
        DbConnectionConfig {
            id: "c1".into(),
            name: "test".into(),
            db_type: "mysql".into(),
            host: host.into(),
            port: 3306,
            user: user.into(),
            password: password.into(),
            database: "app".into(),
            ssl: false,
            sid: String::new(),
            sysdba: false,
            status: "connected".into(),
            enabled: true,
            has_password: !password.is_empty(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn remote_mysql_cli_host_keeps_non_loopback() {
        let conn = sample_conn("192.168.10.20", "cszn", "secret");
        assert_eq!(remote_mysql_cli_host(&conn), "192.168.10.20");
    }

    #[test]
    fn remote_mysql_cli_host_normalizes_loopback() {
        let conn = sample_conn("localhost", "cszn", "secret");
        assert_eq!(remote_mysql_cli_host(&conn), "127.0.0.1");
    }

    #[test]
    fn defaults_file_quotes_credentials_and_host() {
        let conn = sample_conn("db.example.com", "u#1", r#"p"ass"#);
        let cnf = build_defaults_file_content(&conn, remote_mysql_cli_host(&conn), 3307);
        assert!(cnf.contains(r#"user="u#1""#));
        assert!(cnf.contains(r#"password="p\"ass""#));
        assert!(cnf.contains(r#"host="db.example.com""#));
        assert!(cnf.contains("port=3307"));
    }

    #[test]
    fn docker_mysqldump_passes_password_flag() {
        let conn = sample_conn("127.0.0.1", "cszn", "secret");
        let cmd = build_docker_mysqldump_shell(&conn, "app_db", 3306, true);
        assert!(cmd.contains(r#"--password="$MYSQL_PWD""#), "{cmd}");
        assert!(!cmd.contains(" -p "), "{cmd}");
        assert!(!cmd.contains(" -p--"), "{cmd}");
        assert!(cmd.contains("--databases"));
        assert!(cmd.contains("-h127.0.0.1"));
        assert!(cmd.contains("-u'cszn'"));
    }

    #[test]
    fn docker_mysqldump_omits_create_database_when_cloning() {
        let conn = sample_conn("127.0.0.1", "cszn", "secret");
        let cmd = build_docker_mysqldump_shell(&conn, "app_db", 3306, false);
        assert!(!cmd.contains("--databases"), "{cmd}");
        assert!(cmd.contains("'app_db'"), "{cmd}");
    }

    #[test]
    fn docker_mysql_client_passes_password_flag() {
        let conn = sample_conn("127.0.0.1", "cszn", "secret");
        let cmd = build_docker_mysql_client_shell(&conn, 3306, "target_db");
        assert!(cmd.contains(r#"--password="$MYSQL_PWD""#), "{cmd}");
        assert!(!cmd.contains(" -p "), "{cmd}");
        assert!(cmd.contains("'target_db'"), "{cmd}");
    }
}

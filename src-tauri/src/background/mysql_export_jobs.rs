use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_store::DbConnectionConfig;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::background::ssh_pool::SshPool;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MysqlExportDeployment {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MysqlExportRecord {
    pub id: String,
    pub connection_id: String,
    pub database_name: String,
    pub file_name: String,
    pub file_path: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub file_size: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskMysqlExportEvent {
    pub task_id: String,
    pub event_type: String,
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<MysqlExportRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn exports_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?
        .join("mysql-exports");
    fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    Ok(dir)
}

fn connection_exports_dir(app: &AppHandle, connection_id: &str) -> Result<PathBuf, String> {
    let dir = exports_root(app)?.join(connection_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建连接导出目录失败: {e}"))?;
    Ok(dir)
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
    let json = serde_json::to_string_pretty(record).map_err(|e| format!("序列化导出记录失败: {e}"))?;
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

pub fn list_mysql_exports(
    app: &AppHandle,
    connection_id: &str,
) -> Result<Vec<MysqlExportRecord>, String> {
    let base_dir = connection_exports_dir(app, connection_id)?;
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
    app: &AppHandle,
    connection_id: &str,
    export_id: &str,
) -> Result<MysqlExportRecord, String> {
    let base_dir = connection_exports_dir(app, connection_id)?;
    let mut record = read_record(&base_dir, export_id)?;
    refresh_record_size(&base_dir, &mut record);
    Ok(record)
}

pub fn copy_mysql_export_file(
    app: &AppHandle,
    connection_id: &str,
    export_id: &str,
    dest_path: &str,
) -> Result<String, String> {
    if dest_path.trim().is_empty() {
        return Err("未指定目标路径".to_string());
    }
    let record = resolve_export_record(app, connection_id, export_id)?;
    let source = PathBuf::from(&record.file_path);
    if !source.is_file() {
        return Err("导出文件不存在".to_string());
    }
    let base_dir = connection_exports_dir(app, connection_id)?;
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

fn sanitize_db_name(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("数据库名称无效".to_string());
    }
    Ok(name.to_string())
}

fn build_mysqldump_shell_with_defaults(defaults_file: &str, database_name: &str) -> String {
    format!(
        "mysqldump --defaults-extra-file={defaults} --single-transaction --routines --triggers --events --set-gtid-purged=OFF --databases {db}",
        defaults = shell_single_quote(defaults_file),
        db = shell_single_quote(database_name),
    )
}

fn build_docker_mysqldump_shell(connection: &DbConnectionConfig, database_name: &str) -> String {
    format!(
        "mysqldump -h127.0.0.1 -P{port} -u{user} --single-transaction --routines --triggers --events --set-gtid-purged=OFF --databases {db}",
        port = connection.port,
        user = shell_single_quote(&connection.user),
        db = shell_single_quote(database_name),
    )
}

fn build_defaults_file_content(connection: &DbConnectionConfig, host: &str) -> String {
    format!(
        "[client]\nuser={}\npassword={}\nhost={}\nport={}\n",
        connection.user, connection.password, host, connection.port
    )
}

async fn emit_export_event(app: &AppHandle, event: BgTaskMysqlExportEvent) {
    let _ = app.emit("bg-task-mysql-export-event", &event);
}

async fn run_local_mysqldump(
    connection: &DbConnectionConfig,
    database_name: &str,
    output_path: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    let defaults_path = output_path.with_extension("cnf");
    let defaults_content = build_defaults_file_content(connection, &connection.host);
    fs::write(&defaults_path, defaults_content).map_err(|e| format!("写入 mysqldump 配置失败: {e}"))?;

    let mut command = tokio::process::Command::new("mysqldump");
    command
        .arg(format!("--defaults-extra-file={}", defaults_path.display()))
        .arg("--single-transaction")
        .arg("--routines")
        .arg("--triggers")
        .arg("--events")
        .arg("--set-gtid-purged=OFF")
        .arg("--databases")
        .arg(database_name)
        .stdout(std::process::Stdio::from(
            fs::File::create(output_path).map_err(|e| format!("创建导出文件失败: {e}"))?,
        ))
        .stderr(std::process::Stdio::piped());

    let output = command
        .output()
        .await
        .map_err(|e| format!("启动 mysqldump 失败: {e}"))?;
    let _ = fs::remove_file(&defaults_path);

    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(output_path);
        return Err("任务已取消".to_string());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = fs::remove_file(output_path);
        return Err(if stderr.trim().is_empty() {
            format!("mysqldump 退出码 {}", output.status.code().unwrap_or(-1))
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(())
}

async fn run_remote_mysqldump(
    ssh_pool: &SshPool,
    ssh_connection_id: &str,
    connection: &DbConnectionConfig,
    database_name: &str,
    deployment: &MysqlExportDeployment,
    output_path: &Path,
    export_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }

    let session = ssh_pool
        .ensure_session(ssh_connection_id)
        .await
        .map_err(|e| format!("SSH 连接失败: {e}"))?;

    let remote_defaults = format!("/tmp/omnipanel-export-{export_id}.cnf");
    let remote_sql = format!("/tmp/omnipanel-export-{export_id}.sql");
    let defaults_content = build_defaults_file_content(connection, "127.0.0.1");
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
        format!(
            "docker exec -e MYSQL_PWD={} {} sh -c {} > {}",
            shell_single_quote(&connection.password),
            shell_single_quote(container_id),
            shell_single_quote(&build_docker_mysqldump_shell(connection, database_name)),
            shell_single_quote(&remote_sql),
        )
    } else {
        format!(
            "{} > {}",
            build_mysqldump_shell_with_defaults(&remote_defaults, database_name),
            shell_single_quote(&remote_sql),
        )
    };

    let dump_output = session
        .exec_capture(&dump_cmd)
        .await
        .map_err(|e| format!("远端 mysqldump 执行失败: {e}"))?;
    if deployment.kind != "docker" {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_defaults)));
    }

    if cancel.load(Ordering::Relaxed) {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_sql)));
        return Err("任务已取消".to_string());
    }
    if dump_output.exit_code != 0 {
        let _ = session.exec_capture(&format!("rm -f {}", shell_single_quote(&remote_sql)));
        let detail = if dump_output.stderr.trim().is_empty() {
            dump_output.stdout.trim().to_string()
        } else {
            dump_output.stderr.trim().to_string()
        };
        return Err(if detail.is_empty() {
            format!("远端 mysqldump 失败，退出码 {}", dump_output.exit_code)
        } else {
            detail
        });
    }

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

pub async fn run_mysql_export(
    app: AppHandle,
    ssh_pool: Arc<SshPool>,
    task_id: String,
    connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let database_name = sanitize_db_name(&database_name)?;
    let export_id = format!("export-{}", now_millis());
    let base_dir = connection_exports_dir(&app, &connection.id)?;
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
    write_record(&base_dir, &record)?;
    emit_export_event(
        &app,
        BgTaskMysqlExportEvent {
            task_id: task_id.clone(),
            event_type: "started".to_string(),
            connection_id: connection.id.clone(),
            export: Some(record.clone()),
            error: None,
        },
    )
    .await;

    progress(
        format!("正在导出数据库 {database_name}…"),
        0,
        1,
        None,
        None,
    );

    let dump_result = if deployment.kind == "host" || deployment.kind == "docker" {
        let ssh_id = deployment
            .ssh_connection_id
            .clone()
            .ok_or_else(|| "缺少 SSH 连接".to_string())?;
        run_remote_mysqldump(
            &ssh_pool,
            &ssh_id,
            &connection,
            &database_name,
            &deployment,
            &output_path,
            &export_id,
            &cancel,
        )
        .await
    } else {
        run_local_mysqldump(&connection, &database_name, &output_path, &cancel).await
    };

    match dump_result {
        Ok(()) => {
            refresh_record_size(&base_dir, &mut record);
            record.status = "completed".to_string();
            write_record(&base_dir, &record)?;
            progress(format!("导出完成：{database_name}"), 1, 1, None, None);
            emit_export_event(
                &app,
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
            let _ = fs::remove_file(&output_path);
            record.status = "failed".to_string();
            record.error = Some(error.clone());
            write_record(&base_dir, &record)?;
            emit_export_event(
                &app,
                BgTaskMysqlExportEvent {
                    task_id,
                    event_type: "failed".to_string(),
                    connection_id: connection.id.clone(),
                    export: Some(record),
                    error: Some(error.clone()),
                },
            )
            .await;
            Err(error)
        }
    }
}

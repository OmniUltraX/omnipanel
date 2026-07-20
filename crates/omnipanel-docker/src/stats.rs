//! 容器 CPU / 内存 stats：统一解析与拉取。
//!
//! | 来源 | 策略 |
//! |------|------|
//! | SSH 宿主机 | 单次 `docker stats --no-stream --format '{{json .}}'` |
//! | 本地 Engine | bollard one-shot 双帧采样（CPU delta） |
//! | 1Panel | 面板 API（见 [`crate::onepanel`]） |

use std::time::{SystemTime, UNIX_EPOCH};

use bollard::Docker;
use bollard::query_parameters::{ListContainersOptionsBuilder, StatsOptionsBuilder};
use futures::stream::{self, StreamExt};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;

use crate::model::DockerContainerStats;

// ── SSH：docker stats CLI ────────────────────────────────────────────────────

/// SSH 宿主机批量拉取容器 stats 的最长等待（含排队拿 exec 闸门）。
const SSH_STATS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// SSH 宿主机批量拉取容器 stats。
pub async fn list_via_ssh_cli(
    session: &SshSession,
    container_ids: Option<&[String]>,
) -> OmniResult<Vec<DockerContainerStats>> {
    let filter_targets = container_ids.filter(|ids| !ids.is_empty());
    let started = std::time::Instant::now();

    // 始终全量拉取；scoped ID 只用于事后过滤（过滤失败则保留全量供前端匹配）。
    let cmd = docker_stats_shell_cmd();
    tracing::warn!(
        target: "docker_stats",
        source = "ssh",
        cmd = %cmd,
        "SSH docker stats 开始"
    );
    eprintln!("[docker_stats] ssh exec start");

    let out = match tokio::time::timeout(SSH_STATS_TIMEOUT, session.exec_capture(&cmd)).await {
        Ok(result) => result?,
        Err(_) => {
            eprintln!(
                "[docker_stats] ssh exec timeout after {}ms",
                started.elapsed().as_millis()
            );
            return Err(OmniError::new(
                ErrorCode::Timeout,
                format!(
                    "SSH docker stats 超时 ({}s)，请检查远端 Docker 或关闭占用会话的长命令后重试",
                    SSH_STATS_TIMEOUT.as_secs()
                ),
            ));
        }
    };
    let out = out.ok_or_err("docker stats 失败")?;
    let exec_ms = started.elapsed().as_millis();
    let mut stats = parse_cli_output(&out.stdout);

    tracing::warn!(
        target: "docker_stats",
        source = "ssh",
        exec_ms,
        stdout_len = out.stdout.len(),
        parsed_count = stats.len(),
        stderr_len = out.stderr.len(),
        "SSH docker stats 完成"
    );
    eprintln!(
        "[docker_stats] ssh exec done exec_ms={exec_ms} parsed={} stdout_len={}",
        stats.len(),
        out.stdout.len()
    );

    if stats.is_empty() && !out.stdout.trim().is_empty() {
        tracing::warn!(
            target: "docker_stats",
            stdout_len = out.stdout.len(),
            stdout_preview = %preview_text(&out.stdout, 512),
            stderr = %out.stderr.trim(),
            "docker stats 有 stdout 但 JSON 解析结果为空（可能 --format 未生效）"
        );
    }

    if let Some(targets) = filter_targets {
        let filtered = filter_by_targets(stats.clone(), targets);
        if !filtered.is_empty() {
            stats = filtered;
        }
    }

    Ok(stats)
}

/// 构造远端 `docker stats --no-stream` 命令（直接 exec，避免 login shell 读 .bashrc 挂起）。
pub fn docker_stats_shell_cmd() -> String {
    format!(
        "docker stats --no-stream --format {}",
        shell_quote("{{json .}}")
    )
}

fn preview_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= max_chars {
        trimmed.to_string()
    } else {
        format!("{}… (共 {} 字符)", &trimmed[..max_chars], trimmed.len())
    }
}

/// 解析 `docker stats --no-stream` 多行 JSON 输出。
pub fn parse_cli_output(stdout: &str) -> Vec<DockerContainerStats> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            parse_cli_line(trimmed).ok()
        })
        .collect()
}

/// 解析单行 `docker stats --format '{{json .}}'` JSON。
pub fn parse_cli_line(text: &str) -> Result<DockerContainerStats, serde_json::Error> {
    #[derive(serde::Deserialize)]
    struct RawStats {
        #[serde(rename = "ID", alias = "Id", alias = "ContainerID", default)]
        id: Option<String>,
        /// 与 `ID` 并存时优先用 `ID`（docker stats JSON 常同时输出两者）。
        #[serde(rename = "Container", default)]
        container: Option<String>,
        #[serde(rename = "Name", alias = "Names", default)]
        name: Option<String>,
        #[serde(rename = "CPUPerc", default)]
        cpu_perc: Option<String>,
        #[serde(rename = "MemUsage", default)]
        mem_usage: Option<String>,
        #[serde(rename = "MemPerc", default)]
        mem_perc: Option<String>,
        #[serde(rename = "NetIO", default)]
        net_io: Option<String>,
        #[serde(rename = "BlockIO", default)]
        block_io: Option<String>,
    }
    let raw: RawStats = serde_json::from_str(text)?;
    let cpu = parse_percent(&raw.cpu_perc);
    let mem_usage = parse_size_token(&raw.mem_usage);
    let mem_percent = parse_percent(&raw.mem_perc);
    let mem_limit = (mem_usage > 0 && mem_percent > 0.0)
        .then(|| (mem_usage as f64 / (mem_percent / 100.0)) as i64);
    let (rx, tx) = parse_io_pair(&raw.net_io);
    let (blk_r, blk_w) = parse_io_pair(&raw.block_io);
    Ok(DockerContainerStats {
        container_id: raw
            .id
            .or(raw.container)
            .unwrap_or_default(),
        name: raw
            .name
            .unwrap_or_default()
            .trim_start_matches('/')
            .to_string(),
        cpu_percent: cpu,
        memory_usage_bytes: mem_usage,
        memory_limit_bytes: mem_limit,
        memory_percent: mem_percent,
        net_rx_bytes: rx,
        net_tx_bytes: tx,
        block_read_bytes: blk_r,
        block_write_bytes: blk_w,
        timestamp_ms: now_ms(),
    })
}

// ── 本地 Engine：bollard ─────────────────────────────────────────────────────

/// 并发拉取上限，避免对 Docker Engine 瞬时打满连接。
const BOLLARD_STATS_CONCURRENCY: usize = 8;

/// 本地 / TCP Engine 批量拉取容器 stats。
///
/// 使用 one-shot 单次采样并行拉取：Docker 守护进程会在响应中带上上一次采集的
/// `precpu_stats`，足以计算 CPU%；旧实现「每容器串行双采样 + 900ms sleep」在容器稍多时必超时。
pub async fn list_via_bollard(
    docker: &Docker,
    container_ids: Option<&[String]>,
) -> OmniResult<Vec<DockerContainerStats>> {
    let started = std::time::Instant::now();
    let ids = resolve_running_container_ids(docker, container_ids).await?;
    let total = ids.len();
    tracing::warn!(
        target: "docker_stats",
        source = "bollard",
        container_count = total,
        concurrency = BOLLARD_STATS_CONCURRENCY,
        "bollard 并行 one-shot 采样开始"
    );
    eprintln!(
        "[docker_stats] bollard start count={total} concurrency={BOLLARD_STATS_CONCURRENCY}"
    );

    if total == 0 {
        return Ok(Vec::new());
    }

    let docker = docker.clone();
    let results: Vec<(usize, Result<DockerContainerStats, OmniError>)> =
        stream::iter(ids.into_iter().enumerate())
            .map(|(index, id)| {
                let docker = docker.clone();
                async move {
                    let one_started = std::time::Instant::now();
                    let result = sample_bollard_once(&docker, &id).await;
                    if let Err(ref err) = result {
                        tracing::warn!(
                            target: "docker_stats",
                            source = "bollard",
                            index,
                            container = %id,
                            elapsed_ms = one_started.elapsed().as_millis(),
                            error = %err,
                            "单容器 stats 失败，已跳过"
                        );
                    }
                    (index, result)
                }
            })
            .buffer_unordered(BOLLARD_STATS_CONCURRENCY)
            .collect()
            .await;

    let mut indexed: Vec<(usize, DockerContainerStats)> = Vec::with_capacity(total);
    let mut fail = 0usize;
    for (index, result) in results {
        match result {
            Ok(stats) => indexed.push((index, stats)),
            Err(_) => fail += 1,
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    let out: Vec<DockerContainerStats> = indexed.into_iter().map(|(_, s)| s).collect();
    let ok = out.len();
    let elapsed_ms = started.elapsed().as_millis();
    tracing::warn!(
        target: "docker_stats",
        source = "bollard",
        container_count = total,
        ok,
        fail,
        elapsed_ms,
        "bollard 并行 one-shot 采样完成"
    );
    eprintln!(
        "[docker_stats] bollard done count={total} ok={ok} fail={fail} elapsed_ms={elapsed_ms}"
    );
    Ok(out)
}

async fn resolve_running_container_ids(
    docker: &Docker,
    container_ids: Option<&[String]>,
) -> OmniResult<Vec<String>> {
    match container_ids {
        Some(ids) if ids.is_empty() => Ok(Vec::new()),
        Some(ids) => Ok(ids.to_vec()),
        None => {
            let options = ListContainersOptionsBuilder::default().build();
            let raw = docker
                .list_containers(Some(options))
                .await
                .map_err(map_bollard_err)?;
            Ok(raw
                .into_iter()
                .filter_map(|c| c.id)
                .filter(|id| !id.is_empty())
                .collect())
        }
    }
}

async fn sample_bollard_once(docker: &Docker, id: &str) -> OmniResult<DockerContainerStats> {
    let options = StatsOptionsBuilder::default()
        .stream(false)
        .one_shot(true)
        .build();
    let stream = docker.stats(id, Some(options));
    tokio::pin!(stream);
    let item = stream
        .next()
        .await
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "stats 无输出"))?
        .map_err(map_bollard_err)?;
    Ok(convert_engine_stats(id, &item))
}

/// 把 bollard `ContainerStatsResponse` 转为 [`DockerContainerStats`]。
pub fn convert_engine_stats(
    fallback_id: &str,
    s: &bollard::models::ContainerStatsResponse,
) -> DockerContainerStats {
    let id = s.id.clone().unwrap_or_else(|| fallback_id.to_string());
    let name = s
        .name
        .clone()
        .unwrap_or_else(|| id.clone())
        .trim_start_matches('/')
        .to_string();
    let cpu_percent = cpu_percent_from_engine(s);
    let (mem_usage, mem_limit, mem_percent) = memory_stats_from_engine(s);
    let (rx, tx) = network_stats_from_engine(s);
    let (blk_r, blk_w) = blkio_stats_from_engine(s);
    DockerContainerStats {
        container_id: id,
        name,
        cpu_percent,
        memory_usage_bytes: mem_usage,
        memory_limit_bytes: mem_limit,
        memory_percent: mem_percent,
        net_rx_bytes: rx,
        net_tx_bytes: tx,
        block_read_bytes: blk_r,
        block_write_bytes: blk_w,
        timestamp_ms: now_ms(),
    }
}

fn cpu_percent_from_engine(s: &bollard::models::ContainerStatsResponse) -> f64 {
    let cpu = match s.cpu_stats.as_ref() {
        Some(c) => c,
        None => return 0.0,
    };
    let precpu = match s.precpu_stats.as_ref() {
        Some(c) => c,
        None => return 0.0,
    };
    let cpu_total = cpu
        .cpu_usage
        .as_ref()
        .and_then(|u| u.total_usage)
        .unwrap_or(0) as f64;
    let pre_total = precpu
        .cpu_usage
        .as_ref()
        .and_then(|u| u.total_usage)
        .unwrap_or(0) as f64;
    let cpu_sys = cpu.system_cpu_usage.unwrap_or(0) as f64;
    let pre_sys = precpu.system_cpu_usage.unwrap_or(0) as f64;
    let delta_cpu = cpu_total - pre_total;
    let delta_sys = cpu_sys - pre_sys;
    let n_cpus = cpu
        .online_cpus
        .or_else(|| {
            cpu.cpu_usage
                .as_ref()
                .and_then(|u| u.percpu_usage.as_ref().map(|v| v.len() as u32))
        })
        .unwrap_or(1)
        .max(1) as f64;
    if delta_sys <= 0.0 {
        0.0
    } else {
        ((delta_cpu / delta_sys) * n_cpus * 100.0).clamp(0.0, 100.0 * n_cpus)
    }
}

fn memory_stats_from_engine(s: &bollard::models::ContainerStatsResponse) -> (i64, Option<i64>, f64) {
    let m = match s.memory_stats.as_ref() {
        Some(m) => m,
        None => return (0, None, 0.0),
    };
    let usage = m.usage.unwrap_or(0);
    let limit = m.limit.map(|l| l as i64);
    let total_inactive: u64 = m
        .stats
        .as_ref()
        .and_then(|sm| {
            sm.get("total_inactive_file")
                .or_else(|| sm.get("inactive_file"))
                .copied()
        })
        .unwrap_or(0);
    let used: i64 = (usage.saturating_sub(total_inactive) as i64).max(0);
    let percent = match limit {
        Some(l) if l > 0 => (used as f64 / l as f64) * 100.0,
        _ => 0.0,
    };
    (used, limit, percent.clamp(0.0, 100.0))
}

fn network_stats_from_engine(s: &bollard::models::ContainerStatsResponse) -> (i64, i64) {
    let nets = match s.networks.as_ref() {
        Some(n) => n,
        None => return (0, 0),
    };
    let mut rx = 0i64;
    let mut tx = 0i64;
    for n in nets.values() {
        rx = rx.saturating_add(n.rx_bytes.unwrap_or(0) as i64);
        tx = tx.saturating_add(n.tx_bytes.unwrap_or(0) as i64);
    }
    (rx, tx)
}

fn blkio_stats_from_engine(s: &bollard::models::ContainerStatsResponse) -> (i64, i64) {
    let b = match s.blkio_stats.as_ref() {
        Some(b) => b,
        None => return (0, 0),
    };
    let mut r = 0i64;
    let mut w = 0i64;
    if let Some(svc) = b.io_service_bytes_recursive.as_ref() {
        for entry in svc {
            if let (Some(op), Some(val)) = (entry.op.as_deref(), entry.value) {
                match op {
                    "read" | "Read" => r = r.saturating_add(val as i64),
                    "write" | "Write" => w = w.saturating_add(val as i64),
                    _ => {}
                }
            }
        }
    }
    (r, w)
}

fn map_bollard_err(e: bollard::errors::Error) -> OmniError {
    crate::bollard_error::map_bollard_error(e, "Docker Engine 请求失败")
}

// ── 过滤（前端 ID 匹配用） ───────────────────────────────────────────────────

/// 按容器 ID / 名称过滤 stats 列表。
pub fn filter_by_targets(
    stats: Vec<DockerContainerStats>,
    targets: &[String],
) -> Vec<DockerContainerStats> {
    if targets.is_empty() {
        return Vec::new();
    }
    stats
        .into_iter()
        .filter(|item| stats_matches_any_target(item, targets))
        .collect()
}

/// 兼容旧名。
pub fn filter_by_container_ids(
    stats: Vec<DockerContainerStats>,
    container_ids: &[String],
) -> Vec<DockerContainerStats> {
    filter_by_targets(stats, container_ids)
}

fn stats_matches_any_target(item: &DockerContainerStats, targets: &[String]) -> bool {
    if stats_matches_any_id(&item.container_id, targets) {
        return true;
    }
    let item_name = normalize_stats_name(&item.name);
    if item_name.is_empty() {
        return false;
    }
    targets.iter().any(|target| {
        let needle = normalize_stats_name(target);
        !needle.is_empty()
            && (item_name == needle || item_name.ends_with(&needle) || needle.ends_with(&item_name))
    })
}

fn stats_matches_any_id(container_id: &str, container_ids: &[String]) -> bool {
    let normalized = normalize_stats_id(container_id);
    if normalized.is_empty() {
        return false;
    }
    container_ids.iter().any(|id| {
        let needle = normalize_stats_id(id);
        stats_ids_match(&normalized, &needle)
    })
}

fn stats_ids_match(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() {
        return false;
    }
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn normalize_stats_id(id: &str) -> String {
    let trimmed = id.trim().to_lowercase();
    trimmed
        .strip_prefix("sha256:")
        .unwrap_or(&trimmed)
        .to_string()
}

fn normalize_stats_name(name: &str) -> String {
    name.trim().trim_start_matches('/').to_lowercase()
}

// ── CLI 字段解析 ─────────────────────────────────────────────────────────────

fn parse_percent(s: &Option<String>) -> f64 {
    s.as_deref()
        .and_then(|t| t.trim().trim_end_matches('%').parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn parse_size_token(s: &Option<String>) -> i64 {
    let first = s
        .as_deref()
        .and_then(|t| t.split('/').next())
        .unwrap_or("")
        .trim();
    human_size_to_bytes(first)
}

fn parse_io_pair(s: &Option<String>) -> (i64, i64) {
    let parts: Vec<&str> = s
        .as_deref()
        .map(|t| t.split('/').collect())
        .unwrap_or_default();
    if parts.len() < 2 {
        return (0, 0);
    }
    (
        human_size_to_bytes(parts[0].trim()),
        human_size_to_bytes(parts[1].trim()),
    )
}

fn human_size_to_bytes(text: &str) -> i64 {
    let t = text.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("n/a") {
        return 0;
    }
    let split = t.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let value: f64 = num.trim().parse().unwrap_or(0.0);
    let multiplier = match unit.trim().to_uppercase().as_str() {
        "B" | "" => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        "KIB" => 1_024.0,
        "MIB" => 1_048_576.0,
        "GIB" => 1_073_741_824.0,
        _ => 1.0,
    };
    (value * multiplier) as i64
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cli_line_reads_docker_field_names() {
        let line = r#"{"BlockIO":"0B / 0B","CPUPerc":"12.34%","ID":"abc123def456","MemPerc":"45.67%","MemUsage":"100MiB / 2GiB","Name":"web","NetIO":"1kB / 2kB","PIDs":"5"}"#;
        let stats = parse_cli_line(line).expect("parse");
        assert_eq!(stats.container_id, "abc123def456");
        assert_eq!(stats.name, "web");
        assert!((stats.cpu_percent - 12.34).abs() < 0.01);
        assert!((stats.memory_percent - 45.67).abs() < 0.01);
        assert!(stats.memory_usage_bytes > 0);
    }

    #[test]
    fn parse_cli_line_reads_container_alias() {
        let line = r#"{"BlockIO":"0B / 0B","CPUPerc":"1.00%","Container":"abc123def4567890","MemPerc":"10.00%","MemUsage":"50MiB / 1GiB","Name":"/yudao-gateway","NetIO":"0B / 0B","PIDs":"3"}"#;
        let stats = parse_cli_line(line).expect("parse");
        assert_eq!(stats.container_id, "abc123def4567890");
        assert_eq!(stats.name, "yudao-gateway");
    }

    #[test]
    fn docker_stats_shell_cmd_quotes_go_template() {
        let cmd = docker_stats_shell_cmd();
        assert!(cmd.starts_with("docker stats --no-stream --format "));
        assert!(cmd.contains("{{json .}}"));
        // 单引号包裹 Go template，避免远端 shell 展开
        assert!(cmd.contains("'{{json .}}'"));
    }

    #[test]
    fn docker_stats_shell_cmd_avoids_login_shell() {
        let cmd = docker_stats_shell_cmd();
        assert!(!cmd.contains("bash -lc"));
        assert!(!cmd.contains("--login"));
    }

    #[test]
    fn parse_cli_line_reads_server_sample() {
        let line = r#"{"BlockIO":"114MB / 0B","CPUPerc":"0.00%","Container":"42c94e2ccda4","ID":"42c94e2ccda4","MemPerc":"0.36%","MemUsage":"54.01MiB / 14.73GiB","Name":"caishi-web","NetIO":"164MB / 242MB","PIDs":"11"}"#;
        let stats = parse_cli_line(line).expect("parse");
        assert_eq!(stats.container_id, "42c94e2ccda4");
        assert_eq!(stats.name, "caishi-web");
        assert!(stats.memory_usage_bytes > 0);
    }

    #[test]
    fn filter_by_targets_matches_name() {
        let stats = vec![DockerContainerStats {
            container_id: "abc123".into(),
            name: "yudao-cloud-gateway".into(),
            cpu_percent: 1.0,
            memory_usage_bytes: 100,
            memory_limit_bytes: Some(1000),
            memory_percent: 10.0,
            net_rx_bytes: 0,
            net_tx_bytes: 0,
            block_read_bytes: 0,
            block_write_bytes: 0,
            timestamp_ms: 0,
        }];
        let filtered = filter_by_targets(stats, &["yudao-cloud-gateway".into()]);
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn filter_by_targets_matches_full_id_prefix() {
        let stats = vec![DockerContainerStats {
            container_id: "7b56fbb2cb31".into(),
            name: "yudao-gateway".into(),
            cpu_percent: 2.5,
            memory_usage_bytes: 100,
            memory_limit_bytes: Some(1000),
            memory_percent: 10.0,
            net_rx_bytes: 0,
            net_tx_bytes: 0,
            block_read_bytes: 0,
            block_write_bytes: 0,
            timestamp_ms: 0,
        }];
        let full_id = "7b56fbb2cb3123b661028e2f5740f62b76c10f2e4ac9fd26fe84f18ed1cd025e";
        let filtered = filter_by_targets(stats, &[full_id.into()]);
        assert_eq!(filtered.len(), 1);
    }
}

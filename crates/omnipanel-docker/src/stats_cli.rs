//! `docker stats --format '{{json .}}'` 输出解析与批量拉取（本地 / SSH 共用）。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};

use crate::model::DockerContainerStats;

/// 解析 `docker stats --no-stream` 的多行 JSON 输出。
pub fn parse_docker_stats_output(stdout: &str) -> Vec<DockerContainerStats> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            match parse_docker_stats_json(trimmed) {
                Ok(stats) => Some(stats),
                Err(e) => {
                    tracing::debug!(
                        target: "docker_stats",
                        line = trimmed,
                        error = %e,
                        "跳过无法解析的 stats 行"
                    );
                    None
                }
            }
        })
        .collect()
}

/// 解析单行 `docker stats --format '{{json .}}'` JSON。
pub fn parse_docker_stats_json(text: &str) -> Result<DockerContainerStats, serde_json::Error> {
    #[derive(serde::Deserialize)]
    struct RawStats {
        #[serde(
            rename = "ID",
            alias = "Id",
            alias = "Container",
            alias = "ContainerID",
            default
        )]
        id: Option<String>,
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
        container_id: raw.id.unwrap_or_default(),
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
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    })
}

/// 本地 Engine：调用 `docker stats --no-stream` 批量获取运行中容器 stats。
/// `container_ids` 为空切片时直接返回空列表；为 `None` 时统计全部运行中容器。
pub async fn list_local_container_stats(
    container_ids: Option<&[String]>,
) -> OmniResult<Vec<DockerContainerStats>> {
    if matches!(container_ids, Some(ids) if ids.is_empty()) {
        return Ok(Vec::new());
    }
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new("docker");
    cmd.arg("stats")
        .arg("--no-stream")
        .arg("--format")
        .arg("{{json .}}");
    if let Some(ids) = container_ids {
        for id in ids {
            cmd.arg(id);
        }
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd.output().await.map_err(|e| {
        OmniError::new(ErrorCode::Internal, "执行 docker stats 失败").with_cause(e.to_string())
    })?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        tracing::debug!(
            target: "docker_stats",
            exit_code = ?output.status.code(),
            stderr = %stderr.trim(),
            scoped = container_ids.map(|ids| ids.len()),
            "docker stats CLI 失败"
        );
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!("docker stats 失败: {}", stderr.trim()),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stats = parse_docker_stats_output(&stdout);
    tracing::debug!(
        target: "docker_stats",
        source = "local_cli",
        scoped = container_ids.map(|ids| ids.len()),
        line_count = stdout.lines().filter(|l| !l.trim().is_empty()).count(),
        parsed_count = stats.len(),
        sample = ?stats.first().map(|s| (s.container_id.as_str(), s.cpu_percent, s.memory_percent)),
        "list_container_stats 完成"
    );
    Ok(stats)
}

/// 按容器 ID（支持短 ID 后缀匹配）或容器名过滤 stats 列表。
pub fn filter_stats_by_container_ids(
    stats: Vec<DockerContainerStats>,
    container_ids: &[String],
) -> Vec<DockerContainerStats> {
    filter_stats_by_targets(stats, container_ids)
}

/// 按容器 ID / 名称过滤 stats 列表（Compose 场景常用名称匹配）。
pub fn filter_stats_by_targets(
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

fn normalize_stats_name(name: &str) -> String {
    name.trim().trim_start_matches('/').to_lowercase()
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

fn normalize_stats_id(id: &str) -> String {
    let trimmed = id.trim().to_lowercase();
    trimmed
        .strip_prefix("sha256:")
        .unwrap_or(&trimmed)
        .to_string()
}

fn stats_matches_any_id(container_id: &str, container_ids: &[String]) -> bool {
    let normalized = normalize_stats_id(container_id);
    if normalized.is_empty() {
        return false;
    }
    container_ids.iter().any(|id| {
        let needle = normalize_stats_id(id);
        if needle.is_empty() {
            return false;
        }
        normalized == needle
            || normalized.ends_with(&needle)
            || needle.ends_with(&normalized)
    })
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_docker_stats_json_reads_docker_cli_field_names() {
        let line = r#"{"BlockIO":"0B / 0B","CPUPerc":"12.34%","ID":"abc123def456","MemPerc":"45.67%","MemUsage":"100MiB / 2GiB","Name":"web","NetIO":"1kB / 2kB","PIDs":"5"}"#;
        let stats = parse_docker_stats_json(line).expect("parse");
        assert_eq!(stats.container_id, "abc123def456");
        assert_eq!(stats.name, "web");
        assert!((stats.cpu_percent - 12.34).abs() < 0.01);
        assert!((stats.memory_percent - 45.67).abs() < 0.01);
        assert!(stats.memory_usage_bytes > 0);
    }

    #[test]
    fn parse_docker_stats_json_reads_container_field_alias() {
        let line = r#"{"BlockIO":"0B / 0B","CPUPerc":"1.00%","Container":"abc123def4567890","MemPerc":"10.00%","MemUsage":"50MiB / 1GiB","Name":"/yudao-gateway","NetIO":"0B / 0B","PIDs":"3"}"#;
        let stats = parse_docker_stats_json(line).expect("parse");
        assert_eq!(stats.container_id, "abc123def4567890");
        assert_eq!(stats.name, "yudao-gateway");
    }

    #[test]
    fn filter_stats_by_targets_matches_name() {
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
        let filtered = filter_stats_by_targets(stats, &["yudao-cloud-gateway".into()]);
        assert_eq!(filtered.len(), 1);
    }
}

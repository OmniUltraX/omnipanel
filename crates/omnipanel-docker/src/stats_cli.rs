//! `docker stats --format '{{json .}}'` 输出解析与批量拉取（本地 / SSH 共用）。

use crate::model::DockerContainerStats;

/// 调试日志截断，避免超长 stdout 撑爆终端。
pub(crate) fn truncate_debug_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= max_chars {
        trimmed.to_string()
    } else {
        format!("{}… (共 {} 字符)", &trimmed[..max_chars], trimmed.len())
    }
}

/// 构造远端 shell 可执行的 `docker stats` 命令（Go template 需单引号包裹）。
pub(crate) fn docker_stats_shell_cmd(container_ids: Option<&[String]>) -> String {
    let mut cmd = "docker stats --no-stream --format '{{json .}}'".to_string();
    if let Some(ids) = container_ids {
        for id in ids {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                cmd.push(' ');
                cmd.push_str(trimmed);
            }
        }
    }
    cmd
}

/// 去重 stats 拉取目标：优先保留完整容器 ID，避免 id+name 重复触发逐容器回退。
pub(crate) fn dedupe_stats_targets(targets: &[String]) -> Vec<String> {
    use std::collections::HashSet;
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for target in targets {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            continue;
        }
        let id_key = normalize_stats_id(trimmed);
        if id_key.len() >= 12 {
            if seen.insert(id_key) {
                out.push(trimmed.to_string());
            }
            continue;
        }
        let name_key = format!("name:{}", normalize_stats_name(trimmed));
        if seen.insert(name_key) {
            out.push(trimmed.to_string());
        }
    }
    out
}

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

/// 按容器 ID（支持短 ID 前缀匹配）或容器名过滤 stats 列表。
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

fn stats_ids_match(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() {
        return false;
    }
    left == right || left.starts_with(right) || right.starts_with(left)
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

/// 转为 `docker stats` CLI 可接受的容器参数（12 位短 ID 即可）。
pub(crate) fn stats_docker_cli_arg(target: &str) -> String {
    let normalized = normalize_stats_id(target);
    if normalized.len() > 12 {
        normalized.chars().take(12).collect()
    } else {
        normalized
    }
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
    fn docker_stats_shell_cmd_quotes_go_template() {
        assert_eq!(
            docker_stats_shell_cmd(None),
            "docker stats --no-stream --format '{{json .}}'"
        );
    }

    #[test]
    fn dedupe_stats_targets_dedupes_repeated_ids() {
        let id = "7b56fbb2cb3123b661028e2f5740f62b76c10f2e4ac9fd26fe84f18ed1cd025e";
        let deduped = dedupe_stats_targets(&[id.into(), id.into(), "yudao-tiku".into()]);
        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0], id);
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

    #[test]
    fn filter_stats_by_targets_matches_full_id_prefix() {
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
        let filtered = filter_stats_by_targets(stats, &[full_id.into()]);
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn stats_docker_cli_arg_uses_short_prefix() {
        assert_eq!(
            stats_docker_cli_arg("7b56fbb2cb3123b661028e2f5740f62b76c10f2e4ac9fd26fe84f18ed1cd025e"),
            "7b56fbb2cb31"
        );
    }
}

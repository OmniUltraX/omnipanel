//! 容器日志查询参数解析（since / tail）。

use chrono::{DateTime, Utc};

use crate::model::DockerLogQuery;

impl DockerLogQuery {
    pub fn tail_or_default(&self) -> i64 {
        if self.tail <= 0 { 500 } else { self.tail }
    }

    /// 1Panel `download/log` 的 `since` 字段。
    pub fn since_for_onepanel(&self) -> String {
        match self
            .since
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None | Some("all") => "all".to_string(),
            Some(s) => s.to_string(),
        }
    }

    /// bollard `LogsOptions.since`（Unix 秒）。
    pub fn since_for_bollard(&self) -> Option<i64> {
        since_to_unix_seconds(&self.since)
    }

    /// `docker logs --since` 参数字符串。
    pub fn since_for_docker_cli(&self) -> Option<String> {
        match self
            .since
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
        {
            None => None,
            Some(s) => Some(s.to_string()),
        }
    }
}

fn since_to_unix_seconds(since: &Option<String>) -> Option<i64> {
    let s = since.as_deref()?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("all") {
        return None;
    }
    if let Some(secs) = parse_duration_seconds(s) {
        return Some(Utc::now().timestamp() - secs);
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    s.parse::<i64>().ok()
}

fn parse_duration_seconds(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 2 {
        return None;
    }
    let unit = s.chars().last()?;
    let num_str = &s[..s.len() - 1];
    let num: i64 = num_str.parse().ok()?;
    match unit {
        's' => Some(num),
        'm' => Some(num * 60),
        'h' => Some(num * 3600),
        'd' => Some(num * 86_400),
        _ => None,
    }
}

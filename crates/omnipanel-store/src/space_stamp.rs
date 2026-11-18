//! 更新日期不拿来让人挑。顶层 `updatedAt` 一类字段取较大的数字，其余正文保持原样。

use serde_json::{Map, Value};

pub(crate) const STAMP_RESOLVED: &str = "更新日期已采用较新的一份";

pub(crate) enum StampFold {
    /// 不是两边都是对象，或日期没有差异。沿用原来的整文件冲突。
    Untouched,
    /// 只有日期不同。正文已写成较新的日期，不要记冲突。
    OnlyStamp(Vec<u8>),
    /// 还有别的内容不同。两份正文的日期都改成较新的，冲突照旧保留。
    Content { current: Vec<u8>, saved: Vec<u8> },
}

/// `local` 是没被采用的本机正文，`remote` 是正在用的云端正文。
pub(crate) fn fold_update_stamps(local: &[u8], remote: &[u8]) -> StampFold {
    let (Ok(local_text), Ok(remote_text)) =
        (std::str::from_utf8(local), std::str::from_utf8(remote))
    else {
        return StampFold::Untouched;
    };
    let (Some(local_obj), Some(remote_obj)) = (parse_object(local_text), parse_object(remote_text))
    else {
        return StampFold::Untouched;
    };

    let mut updates = Vec::new();
    let mut content_diff = false;
    let mut keys: Vec<String> = local_obj.keys().cloned().collect();
    for key in remote_obj.keys() {
        if !local_obj.contains_key(key) {
            keys.push(key.clone());
        }
    }
    for key in keys {
        let left = local_obj.get(&key);
        let right = remote_obj.get(&key);
        if is_stamp_key(&key) {
            match stamp_pair(left, right) {
                StampPair::Same => {}
                StampPair::Max(value) => updates.push((key, value)),
                StampPair::Content => content_diff = true,
            }
        } else if !values_eq(left, right) {
            content_diff = true;
        }
    }
    if updates.is_empty() {
        return StampFold::Untouched;
    }
    let Some(current) = apply_stamps(remote_text, &updates) else {
        return StampFold::Untouched;
    };
    if !content_diff {
        return StampFold::OnlyStamp(current.into_bytes());
    }
    let Some(saved) = apply_stamps(local_text, &updates) else {
        return StampFold::Untouched;
    };
    StampFold::Content {
        current: current.into_bytes(),
        saved: saved.into_bytes(),
    }
}

fn parse_object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn is_stamp_key(key: &str) -> bool {
    let mut name = String::new();
    for ch in key.chars() {
        if ch == '_' {
            continue;
        }
        name.push(ch.to_ascii_lowercase());
    }
    matches!(
        name.as_str(),
        "updatedat"
            | "updateat"
            | "modifiedat"
            | "lastmodified"
            | "lastmodifiedat"
            | "updatetime"
            | "updatedtime"
            | "modifiedtime"
    )
}

enum StampPair {
    Same,
    Max(i64),
    Content,
}

fn stamp_pair(local: Option<&Value>, remote: Option<&Value>) -> StampPair {
    match (local, remote) {
        (None, None) => StampPair::Same,
        (Some(left), Some(right)) => match (stamp_num(left), stamp_num(right)) {
            (Some(left_n), Some(right_n)) if left_n == right_n => StampPair::Same,
            (Some(left_n), Some(right_n)) => StampPair::Max(left_n.max(right_n)),
            _ if left == right => StampPair::Same,
            _ => StampPair::Content,
        },
        (Some(value), None) | (None, Some(value)) => match stamp_num(value) {
            Some(number) => StampPair::Max(number),
            None => StampPair::Content,
        },
    }
}

fn stamp_num(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    value.as_str().and_then(|text| text.trim().parse().ok())
}

fn values_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

struct Field {
    key: String,
    value_start: usize,
    value_end: usize,
}

struct TopLevel {
    fields: Vec<Field>,
    close: usize,
    empty: bool,
}

fn apply_stamps(raw: &str, updates: &[(String, i64)]) -> Option<String> {
    let top = scan_top_level(raw)?;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut missing: Vec<(String, i64)> = Vec::new();
    for (key, value) in updates {
        let mut found = false;
        for field in top.fields.iter().filter(|field| &field.key == key) {
            found = true;
            let current = &raw[field.value_start..field.value_end];
            let replacement = format_like(current, *value);
            if replacement != current {
                edits.push((field.value_start, field.value_end, replacement));
            }
        }
        if !found {
            missing.push((key.clone(), *value));
        }
    }
    if !missing.is_empty() {
        edits.push((top.close, top.close, insertion(top.empty, &missing)));
    }
    if edits.is_empty() {
        return Some(raw.to_string());
    }
    edits.sort_by(|left, right| right.0.cmp(&left.0).then(right.1.cmp(&left.1)));
    let mut out = raw.to_string();
    for (start, end, text) in edits {
        out.replace_range(start..end, &text);
    }
    Some(out)
}

fn format_like(current: &str, value: i64) -> String {
    let trimmed = current.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

fn insertion(empty: bool, missing: &[(String, i64)]) -> String {
    let mut text = String::new();
    for (index, (key, value)) in missing.iter().enumerate() {
        if !(empty && index == 0) {
            text.push(',');
        }
        text.push('"');
        text.push_str(key);
        text.push_str("\":");
        text.push_str(&value.to_string());
    }
    text
}

fn scan_top_level(raw: &str) -> Option<TopLevel> {
    let bytes = raw.as_bytes();
    let mut index = skip_ws(bytes, 0);
    if bytes.get(index) != Some(&b'{') {
        return None;
    }
    index += 1;
    let mut fields = Vec::new();
    let mut empty = true;
    loop {
        index = skip_ws(bytes, index);
        if bytes.get(index) == Some(&b'}') {
            return Some(TopLevel {
                fields,
                close: index,
                empty,
            });
        }
        empty = false;
        if bytes.get(index) != Some(&b'"') {
            return None;
        }
        let (key, next) = scan_string(raw, index)?;
        index = skip_ws(bytes, next);
        if bytes.get(index) != Some(&b':') {
            return None;
        }
        index = skip_ws(bytes, index + 1);
        let value_start = index;
        index = scan_value(bytes, index)?;
        fields.push(Field {
            key,
            value_start,
            value_end: index,
        });
        index = skip_ws(bytes, index);
        match bytes.get(index) {
            Some(b',') => index += 1,
            Some(b'}') => {
                return Some(TopLevel {
                    fields,
                    close: index,
                    empty: false,
                });
            }
            _ => return None,
        }
    }
}

fn skip_ws(bytes: &[u8], mut index: usize) -> usize {
    while matches!(bytes.get(index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        index += 1;
    }
    index
}

fn scan_string(raw: &str, start: usize) -> Option<(String, usize)> {
    let bytes = raw.as_bytes();
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut index = start + 1;
    let mut out = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                let next = *bytes.get(index + 1)?;
                match next {
                    b'"' | b'\\' | b'/' => out.push(next as char),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hex = std::str::from_utf8(bytes.get(index + 2..index + 6)?).ok()?;
                        let code = u32::from_str_radix(hex, 16).ok()?;
                        out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        index += 6;
                        continue;
                    }
                    _ => return None,
                }
                index += 2;
            }
            b'"' => return Some((out, index + 1)),
            _ => {
                let ch = raw[index..].chars().next()?;
                out.push(ch);
                index += ch.len_utf8();
            }
        }
    }
    None
}

fn scan_value(bytes: &[u8], start: usize) -> Option<usize> {
    match *bytes.get(start)? {
        b'"' => scan_string_end(bytes, start),
        b'{' | b'[' => scan_container(bytes, start),
        _ => {
            let mut index = start;
            while index < bytes.len()
                && !matches!(
                    bytes[index],
                    b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t'
                )
            {
                index += 1;
            }
            if index == start { None } else { Some(index) }
        }
    }
}

fn scan_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

fn scan_container(bytes: &[u8], start: usize) -> Option<usize> {
    let mut stack = vec![closer(*bytes.get(start)?)?];
    let mut index = start + 1;
    let mut in_string = false;
    let mut escape = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escape {
                escape = false;
            } else if byte == b'\\' {
                escape = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => stack.push(b'}'),
            b'[' => stack.push(b']'),
            b'}' | b']' => {
                if stack.pop() != Some(byte) {
                    return None;
                }
                if stack.is_empty() {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn closer(open: u8) -> Option<u8> {
    match open {
        b'{' => Some(b'}'),
        b'[' => Some(b']'),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_updated_at_keeps_the_newer_cloud_bytes() {
        let local = b"{\n  \"name\": \"default\",\n  \"updatedAt\": 1794795976763\n}\n";
        let remote = b"{\n  \"name\": \"default\",\n  \"updatedAt\": 1794884856297\n}\n";
        match fold_update_stamps(local, remote) {
            StampFold::OnlyStamp(body) => assert_eq!(body, remote),
            other => panic!("expected only stamp, got {}", kind(&other)),
        }
    }

    #[test]
    fn only_updated_at_writes_the_newer_local_time_into_the_cloud_body() {
        let local = b"{\"name\":\"default\",\"updatedAt\":1794884856297}\n";
        let remote = b"{\"name\":\"default\",\"updatedAt\":1794795976763}\n";
        match fold_update_stamps(local, remote) {
            StampFold::OnlyStamp(body) => {
                let text = String::from_utf8(body).unwrap();
                assert_eq!(text, "{\"name\":\"default\",\"updatedAt\":1794884856297}\n");
            }
            other => panic!("expected only stamp, got {}", kind(&other)),
        }
    }

    #[test]
    fn other_fields_still_conflict_but_both_sides_get_the_newer_stamp() {
        let local = b"{\"name\":\"local\",\"note\":{\"a\":1},\"updatedAt\":1}";
        let remote = b"{\"name\":\"cloud\",\"note\":{\"a\":1},\"updatedAt\":9}";
        match fold_update_stamps(local, remote) {
            StampFold::Content { current, saved } => {
                let current = String::from_utf8(current).unwrap();
                let saved = String::from_utf8(saved).unwrap();
                assert_eq!(
                    current,
                    "{\"name\":\"cloud\",\"note\":{\"a\":1},\"updatedAt\":9}"
                );
                assert_eq!(
                    saved,
                    "{\"name\":\"local\",\"note\":{\"a\":1},\"updatedAt\":9}"
                );
            }
            other => panic!("expected content, got {}", kind(&other)),
        }
    }

    #[test]
    fn created_at_is_not_an_update_stamp() {
        let local = b"{\"name\":\"a\",\"createdAt\":1}";
        let remote = b"{\"name\":\"a\",\"createdAt\":2}";
        assert!(matches!(
            fold_update_stamps(local, remote),
            StampFold::Untouched
        ));
    }

    #[test]
    fn snake_case_stamp_and_a_missing_side_are_filled() {
        let local = b"{\"name\":\"a\",\"updated_at\":5}";
        let remote = b"{\"name\":\"a\"}";
        match fold_update_stamps(local, remote) {
            StampFold::OnlyStamp(body) => {
                assert_eq!(
                    String::from_utf8(body).unwrap(),
                    "{\"name\":\"a\",\"updated_at\":5}"
                );
            }
            other => panic!("expected only stamp, got {}", kind(&other)),
        }
    }

    #[test]
    fn non_json_stays_a_real_conflict() {
        assert!(matches!(
            fold_update_stamps(b"hello", b"world"),
            StampFold::Untouched
        ));
    }

    fn kind(fold: &StampFold) -> &'static str {
        match fold {
            StampFold::Untouched => "untouched",
            StampFold::OnlyStamp(_) => "only",
            StampFold::Content { .. } => "content",
        }
    }
}

//! 查询结果里的 JSON 值在进 IPC / JS 前的规范化。
//!
//! JS `Number` 仅能精确表示 ±2^53 内的整数；超出后必须用字符串，否则雪花 ID 等会丢精度。

use serde_json::{Map, Value};

/// 整数若落在 JS Number 安全区间（±2^53）内返回 number，否则返回字符串以保留精度。
pub fn safe_int_to_value(v: i128) -> Value {
    const SAFE_MAX: i128 = 1i128 << 53;
    if v.abs() < SAFE_MAX {
        serde_json::json!(v)
    } else {
        Value::String(v.to_string())
    }
}

/// 将 JSON 中超出 JS 安全整数范围的 Number 转为字符串（递归处理对象/数组）。
pub fn sanitize_json_value_for_js(value: Value) -> Value {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return safe_int_to_value(i as i128);
            }
            if let Some(u) = n.as_u64() {
                return safe_int_to_value(u as i128);
            }
            Value::Number(n)
        }
        Value::Array(items) => {
            Value::Array(items.into_iter().map(sanitize_json_value_for_js).collect())
        }
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k, sanitize_json_value_for_js(v));
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// 字节/文本列：仅当内容是 JSON 对象或数组时才解析；纯数字串必须保持字符串，
/// 否则 `serde_json` 会解成 Number，经 IPC 到 JS 后超过 2^53 丢精度
///（VARCHAR BINARY / VARBINARY 等路径常见）。
pub fn decode_text_as_json_or_string(text: String) -> Value {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            return sanitize_json_value_for_js(v);
        }
    }
    Value::String(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bare_digit_string_stays_string() {
        let snowflake = "2056634344658120700".to_string();
        assert_eq!(
            decode_text_as_json_or_string(snowflake.clone()),
            Value::String(snowflake)
        );
        // 邻近 ID 不得塌缩成同一个 Number
        assert_eq!(
            decode_text_as_json_or_string("2056634344658120701".into()),
            Value::String("2056634344658120701".into())
        );
    }

    #[test]
    fn json_object_with_large_int_becomes_string() {
        let raw = r#"{"id":2056634344658120700}"#.to_string();
        let v = decode_text_as_json_or_string(raw);
        assert_eq!(v["id"], Value::String("2056634344658120700".into()));
    }

    #[test]
    fn safe_small_int_stays_number() {
        assert_eq!(safe_int_to_value(42), json!(42));
        assert_eq!(
            safe_int_to_value((1i128 << 53) - 1),
            json!((1i64 << 53) - 1)
        );
    }

    #[test]
    fn unsafe_int_becomes_string() {
        assert_eq!(
            safe_int_to_value(1i128 << 53),
            Value::String((1u64 << 53).to_string())
        );
    }
}

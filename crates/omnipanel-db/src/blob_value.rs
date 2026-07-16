//! BLOB / BYTEA 结果编码：嗅探可预览类型，小体积内联 base64 供前端预览窗展示。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Map, Value};

/// 可内联到查询结果中的最大字节数（图片 / 音频 / 文本）。
pub const BLOB_INLINE_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobPreviewKind {
    Image,
    Audio,
    Text,
    Binary,
}

impl BlobPreviewKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Text => "text",
            Self::Binary => "binary",
        }
    }
}

/// 将二进制列编码为前端可识别的结构化值。
///
/// 形如：
/// ```json
/// { "__omni": "blob", "size": 123, "kind": "image", "mime": "image/png", "encoding": "base64", "data": "..." }
/// ```
/// 过大或不可预览时省略 `encoding` / `data`。
pub fn encode_blob_value(bytes: &[u8]) -> Value {
    let size = bytes.len();
    let (kind, mime) = sniff_blob(bytes);

    let mut map = Map::new();
    map.insert("__omni".into(), Value::String("blob".into()));
    map.insert("size".into(), json!(size));
    map.insert("kind".into(), Value::String(kind.as_str().into()));
    if let Some(mime) = mime {
        map.insert("mime".into(), Value::String(mime.into()));
    }

    let can_preview = matches!(
        kind,
        BlobPreviewKind::Image | BlobPreviewKind::Audio | BlobPreviewKind::Text
    );
    if can_preview && size <= BLOB_INLINE_MAX_BYTES {
        map.insert("encoding".into(), Value::String("base64".into()));
        map.insert("data".into(), Value::String(BASE64.encode(bytes)));
    }

    Value::Object(map)
}

fn sniff_blob(bytes: &[u8]) -> (BlobPreviewKind, Option<&'static str>) {
    if bytes.is_empty() {
        return (BlobPreviewKind::Binary, None);
    }

    let head = &bytes[..bytes.len().min(16)];

    // PNG
    if head.len() >= 8
        && head[0] == 0x89
        && head[1] == 0x50
        && head[2] == 0x4e
        && head[3] == 0x47
    {
        return (BlobPreviewKind::Image, Some("image/png"));
    }
    // JPEG
    if head.len() >= 3 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff {
        return (BlobPreviewKind::Image, Some("image/jpeg"));
    }
    // GIF
    if head.len() >= 4
        && head[0] == 0x47
        && head[1] == 0x49
        && head[2] == 0x46
        && head[3] == 0x38
    {
        return (BlobPreviewKind::Image, Some("image/gif"));
    }
    // WebP
    if head.len() >= 12
        && head[0] == 0x52
        && head[1] == 0x49
        && head[2] == 0x46
        && head[3] == 0x46
        && head[8] == 0x57
        && head[9] == 0x45
        && head[10] == 0x42
        && head[11] == 0x50
    {
        return (BlobPreviewKind::Image, Some("image/webp"));
    }
    // BMP
    if head.len() >= 2 && head[0] == 0x42 && head[1] == 0x4d {
        return (BlobPreviewKind::Image, Some("image/bmp"));
    }
    // WAV
    if head.len() >= 12
        && head[0] == 0x52
        && head[1] == 0x49
        && head[2] == 0x46
        && head[3] == 0x46
        && head[8] == 0x57
        && head[9] == 0x45
        && head[10] == 0x41
        && head[11] == 0x56
    {
        return (BlobPreviewKind::Audio, Some("audio/wav"));
    }
    // OGG
    if head.len() >= 4
        && head[0] == 0x4f
        && head[1] == 0x67
        && head[2] == 0x67
        && head[3] == 0x53
    {
        return (BlobPreviewKind::Audio, Some("audio/ogg"));
    }
    // FLAC
    if head.len() >= 4
        && head[0] == 0x66
        && head[1] == 0x4c
        && head[2] == 0x61
        && head[3] == 0x43
    {
        return (BlobPreviewKind::Audio, Some("audio/flac"));
    }
    // MP3 (ID3 or frame sync)
    if (head.len() >= 3 && head[0] == 0x49 && head[1] == 0x44 && head[2] == 0x33)
        || (head.len() >= 2 && head[0] == 0xff && (head[1] & 0xe0) == 0xe0)
    {
        return (BlobPreviewKind::Audio, Some("audio/mpeg"));
    }
    // MP4 / M4A container
    if head.len() >= 8 && head[4] == 0x66 && head[5] == 0x74 && head[6] == 0x79 && head[7] == 0x70
    {
        return (BlobPreviewKind::Audio, Some("audio/mp4"));
    }

    // SVG / XML 文本图片
    if let Ok(text) = std::str::from_utf8(&bytes[..bytes.len().min(256)]) {
        let trimmed = text.trim_start();
        if trimmed.starts_with("<svg")
            || trimmed.to_ascii_lowercase().contains("<svg")
            || (trimmed.starts_with("<?xml") && text.to_ascii_lowercase().contains("<svg"))
        {
            return (BlobPreviewKind::Image, Some("image/svg+xml"));
        }
    }

    // 可打印 UTF-8 文本（BPMN XML 等）
    if looks_like_utf8_text(bytes) {
        return (BlobPreviewKind::Text, Some("text/plain"));
    }

    (BlobPreviewKind::Binary, Some("application/octet-stream"))
}

fn looks_like_utf8_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    // 含 NUL 视为二进制
    if text.chars().take(512).any(|c| c == '\0') {
        return false;
    }
    text.chars()
        .take(4096)
        .all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_png_and_inlines() {
        let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(b"fake-png-body");
        let value = encode_blob_value(&bytes);
        let obj = value.as_object().unwrap();
        assert_eq!(obj.get("__omni").unwrap(), "blob");
        assert_eq!(obj.get("kind").unwrap(), "image");
        assert_eq!(obj.get("mime").unwrap(), "image/png");
        assert!(obj.get("data").is_some());
    }

    #[test]
    fn binary_without_inline_data() {
        let bytes = vec![0x00, 0x01, 0x02, 0xff];
        let value = encode_blob_value(&bytes);
        let obj = value.as_object().unwrap();
        assert_eq!(obj.get("kind").unwrap(), "binary");
        assert!(obj.get("data").is_none());
    }

    #[test]
    fn utf8_text_blob() {
        let bytes = b"<?xml version=\"1.0\"?><process/>".as_slice();
        let value = encode_blob_value(bytes);
        let obj = value.as_object().unwrap();
        assert_eq!(obj.get("kind").unwrap(), "text");
        assert!(obj.get("data").is_some());
    }
}

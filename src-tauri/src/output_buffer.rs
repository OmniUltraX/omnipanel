use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 后端为每个终端/SSH 会话保留的 scrollback 原始字节缓冲，用于断开重连/前端 remount 时
/// 通过 `terminal_snapshot` 重建屏幕，替代仅依赖前端 outputBuffer 的脆弱方案。
pub type OutputBuffers = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// 单会话缓冲上限（保留尾部），避免长会话占用过多内存。
const MAX_BYTES: usize = 256 * 1024;

pub fn new_buffers() -> OutputBuffers {
    Arc::new(Mutex::new(HashMap::new()))
}

/// 追加输出字节，超出上限时丢弃最旧部分。
pub fn append(buffers: &OutputBuffers, id: &str, data: &[u8]) {
    if let Ok(mut map) = buffers.lock() {
        let buf = map.entry(id.to_string()).or_default();
        buf.extend_from_slice(data);
        if buf.len() > MAX_BYTES {
            let overflow = buf.len() - MAX_BYTES;
            buf.drain(0..overflow);
        }
    }
}

/// 读取会话当前缓冲快照。
pub fn snapshot(buffers: &OutputBuffers, id: &str) -> Option<Vec<u8>> {
    buffers.lock().ok().and_then(|map| map.get(id).cloned())
}

/// 移除会话缓冲（会话关闭时）。
pub fn remove(buffers: &OutputBuffers, id: &str) {
    if let Ok(mut map) = buffers.lock() {
        map.remove(id);
    }
}

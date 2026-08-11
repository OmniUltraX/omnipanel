//! 跨连接中继限速（0 = 不限制）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub(crate) static RATE_LIMIT_BPS: AtomicU64 = AtomicU64::new(0);

pub fn set_rate_limit_bps(bps: u64) {
    RATE_LIMIT_BPS.store(bps, Ordering::Relaxed);
}

pub fn rate_limit_bps() -> u64 {
    RATE_LIMIT_BPS.load(Ordering::Relaxed)
}

/// 按当前限速对已写入字节做节流（异步路径）。
pub async fn throttle_bytes(bytes: u64) {
    let bps = rate_limit_bps();
    if bps == 0 || bytes == 0 {
        return;
    }
    let nanos = (bytes as u128).saturating_mul(1_000_000_000u128) / bps as u128;
    if nanos == 0 {
        return;
    }
    let nanos = nanos.min(u64::MAX as u128) as u64;
    tokio::time::sleep(Duration::from_nanos(nanos)).await;
}

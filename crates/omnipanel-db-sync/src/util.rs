/// 默认后台工作线程数：当前机器 CPU 逻辑核数，至少为 1。
pub fn default_worker_count() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
        .max(1)
}

//! 终端 / SSH 会话输出 scrollback 缓冲（转发到 omnipanel-core 共享实现）。
//!
//! 桌面端与 Web 服务端共用同一份实现：Web 端（`omnipanel-server`）直接复用
//! `omnipanel_core::output_buffer`，前端通过 `terminal_snapshot` 重建屏幕。

pub use omnipanel_core::output_buffer::*;

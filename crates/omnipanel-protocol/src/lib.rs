//! 协议实验室共享实现（从桌面 `src-tauri/src/protocol` 下沉，桌面 / Web 复用）。

pub mod grpc;
pub mod http;
pub mod modbus;
pub mod mqtt;
pub mod proxy;
pub mod redis_pubsub;
pub mod serial;
pub mod sniffer;
pub mod sse;
pub mod ws;

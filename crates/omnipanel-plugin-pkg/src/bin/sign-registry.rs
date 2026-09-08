//! 给 `plugin-registry.json` 签 ed25519。
//!
//! 用法: `sign-registry <registry.json>`
//! 私钥：环境变量 `PLUGIN_REGISTRY_SIGNING_KEY`（32 字节 hex 种子）。

use std::fs;
use std::path::PathBuf;

use ed25519_dalek::SigningKey;
use omnipanel_plugin_pkg::{parse_registry, sign_registry};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("用法: sign-registry <registry.json>");
        std::process::exit(2);
    }
    let path = PathBuf::from(&args[1]);
    let key_hex = std::env::var("PLUGIN_REGISTRY_SIGNING_KEY").unwrap_or_default();
    let key_bytes = match hex::decode(key_hex.trim()) {
        Ok(bytes) if bytes.len() == 32 => bytes,
        _ => {
            eprintln!("PLUGIN_REGISTRY_SIGNING_KEY 必须是 32 字节 hex");
            std::process::exit(2);
        }
    };
    let seed: [u8; 32] = key_bytes.try_into().expect("32 bytes");
    let key = SigningKey::from_bytes(&seed);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(err) => {
            eprintln!("读 registry 失败: {err}");
            std::process::exit(1);
        }
    };
    let mut file = match parse_registry(&text) {
        Ok(f) => f,
        Err(err) => {
            eprintln!("解析 registry 失败: {err}");
            std::process::exit(1);
        }
    };
    file.schema_version = 2;
    let sig = sign_registry(&file, &key);
    file.signature = Some(hex::encode(sig.to_bytes()));
    file.publisher_key = Some(hex::encode(key.verifying_key().to_bytes()));
    match serde_json::to_string_pretty(&file) {
        Ok(json) => {
            if let Err(err) = fs::write(&path, format!("{json}\n")) {
                eprintln!("写 registry 失败: {err}");
                std::process::exit(1);
            }
        }
        Err(err) => {
            eprintln!("序列化失败: {err}");
            std::process::exit(1);
        }
    }
}

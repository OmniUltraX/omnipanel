//! `.omni-plugin` 打包 CLI（dev 签名）。
//!
//! 用法：`cargo run -p omnipanel-plugin-pkg --bin pack -- <plugin_dir> <out.omni-plugin>`
//! 使用开发签名种子；正式发布 MUST 使用离线保管密钥另行签名。

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("用法: pack <plugin_dir> <out.omni-plugin>");
        std::process::exit(2);
    }
    let dir = PathBuf::from(&args[1]);
    let out = PathBuf::from(&args[2]);
    if let Err(err) = omnipanel_plugin_pkg::pack_dir(&dir, &out, Some(&omnipanel_plugin_pkg::devkey::dev_signing_key()))
    {
        eprintln!("打包失败: {err}");
        std::process::exit(1);
    }
    println!("已生成 {}（dev 签名）", out.display());
}

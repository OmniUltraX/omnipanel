//! 将本地明文 `modules/latest.json` 快照合并导入到 `~/.omnipd`。
//!
//! 用法（请先退出 OmniPanel，避免 SQLite 锁冲突）：
//! ```text
//! cargo run -p omnipanel-store --example import_modules_snapshot -- path/to/latest.json
//! ```

use std::env;
use std::fs;
use std::process::ExitCode;

use omnipanel_store::{
    Connection, DatabaseConnectionStore, DbConnectionConfig, HttpCollection, HttpEnvironment,
    KnowledgeEntry, SavedHttpRequest, Storage, meta_db_path,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[serde(default)]
    connections: Vec<ConnectionItem>,
    #[serde(default)]
    database_connections: Vec<DatabaseItem>,
    #[serde(default)]
    knowledge: Vec<KnowledgeEntry>,
    #[serde(default)]
    http_collections: Vec<HttpCollection>,
    #[serde(default)]
    http_environments: Vec<HttpEnvironment>,
    #[serde(default)]
    http_requests: Vec<SavedHttpRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionItem {
    connection: Connection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseItem {
    connection: DbConnectionConfig,
}

fn main() -> ExitCode {
    let path = env::args()
        .nth(1)
        .unwrap_or_else(|| "latest.json".to_string());
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("读取失败 {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let snap: Snapshot = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("解析 JSON 失败: {e}");
            return ExitCode::FAILURE;
        }
    };

    let db_path = match meta_db_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("定位元数据库失败: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("目标库: {}", db_path.display());

    let storage = match Storage::open(&db_path, None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("打开存储失败（请先完全退出 OmniPanel）: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut n_conn = 0usize;
    for item in &snap.connections {
        if let Err(e) = storage.save_connection(&item.connection) {
            eprintln!("保存连接 {} 失败: {e}", item.connection.id);
            continue;
        }
        n_conn += 1;
    }

    let mut n_kn = 0usize;
    for entry in &snap.knowledge {
        if let Err(e) = storage.save_knowledge(entry) {
            eprintln!("保存知识库 {} 失败: {e}", entry.id);
            continue;
        }
        n_kn += 1;
    }

    let mut n_col = 0usize;
    for col in &snap.http_collections {
        if let Err(e) = storage.http_save_collection(col) {
            eprintln!("保存 HTTP 集合 {} 失败: {e}", col.id);
            continue;
        }
        n_col += 1;
    }

    let mut n_env = 0usize;
    for env in &snap.http_environments {
        if let Err(e) = storage.http_save_environment(env) {
            eprintln!("保存 HTTP 环境 {} 失败: {e}", env.id);
            continue;
        }
        n_env += 1;
    }

    let mut n_req = 0usize;
    for req in &snap.http_requests {
        if let Err(e) = storage.http_save_request(req) {
            eprintln!("保存 HTTP 请求 {} 失败: {e}", req.id);
            continue;
        }
        n_req += 1;
    }

    let mut n_db = 0usize;
    match DatabaseConnectionStore::open() {
        Ok(db_store) => {
            for item in &snap.database_connections {
                let mut c = item.connection.clone();
                c.password.clear();
                if let Err(e) = db_store.save(c) {
                    eprintln!("保存数据库连接失败: {e}");
                    continue;
                }
                n_db += 1;
            }
        }
        Err(e) => eprintln!("打开数据库连接库失败（已跳过 DB）: {e}"),
    }

    println!(
        "导入完成（合并写入，未删除本机其它数据）:\n  连接 {n_conn}\n  数据库 {n_db}\n  知识库 {n_kn}\n  HTTP 集合 {n_col}\n  HTTP 环境 {n_env}\n  HTTP 请求 {n_req}"
    );
    println!(
        "请重新打开 OmniPanel 查看。工作区若需同步，侧栏切换到对应组织后再点设置「立即拉取」。"
    );
    println!("提醒：快照可能含 Token/主机信息，导入后请勿把 latest.json 提交到 git。");
    ExitCode::SUCCESS
}

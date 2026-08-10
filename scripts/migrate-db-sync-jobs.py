#!/usr/bin/env python3
"""从桌面 db_sync_jobs.rs 生成 omnipanel-db-sync/src/jobs.rs（UTF-8）。"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / "src-tauri/src/background/db_sync_jobs.rs").read_text(encoding="utf-8")
text = src

# 移除 Tauri
text = re.sub(r"^use tauri::\{[^}]+\};\n", "", text, flags=re.M)
text = text.replace(
    "use crate::background::worker_pool::default_worker_count;",
    "use crate::util::default_worker_count;",
)
text = text.replace(
    "use crate::commands::database::{self, DbColumnMeta, DbIndexMeta};",
    "use crate::db_ops;\nuse omnipanel_db::{DbColumnMeta, DbIndexMeta};",
)
text = text.replace(
    "use crate::commands::db_sync_diff_cache::{build_row_diff_cache_id, load_row_diff_cache_all, save_row_diff_cache};",
    "use crate::row_diff_cache::{build_row_diff_cache_id, load_row_diff_cache_all, save_row_diff_cache};",
)
text = re.sub(r"\bdatabase::", "db_ops::", text)

# AppHandle -> sink
text = text.replace("AppHandle", "Arc<dyn DbSyncEventSink>")

# emit_db_event
text = re.sub(
    r"async fn emit_db_event\(app: &Arc<dyn DbSyncEventSink>, event: BgTaskDbEvent\) \{\s*let _ = app\.emit\(\"bg-task-db-event\", &event\);\s*\}",
    "async fn emit_db_event(sink: &Arc<dyn DbSyncEventSink>, event: BgTaskDbEvent) {\n    sink.emit_db_event(event).await;\n}",
    text,
    flags=re.S,
)

# emit_exec_event first arg
text = text.replace(
    "async fn emit_exec_event(app: &Arc<dyn DbSyncEventSink>, task_id: &str, result: SyncExecResultEvent) {\n    emit_db_event(\n        app,",
    "async fn emit_exec_event(sink: &Arc<dyn DbSyncEventSink>, task_id: &str, result: SyncExecResultEvent) {\n    emit_db_event(\n        sink,",
)

# 路径函数改用 paths 模块
text = re.sub(
    r"fn sync_sql_dir\(app: &Arc<dyn DbSyncEventSink>\).*?^}\n",
    "",
    text,
    count=1,
    flags=re.S | re.M,
)
text = re.sub(
    r"fn write_sync_sql_file\(app: &Arc<dyn DbSyncEventSink>.*?\n}\n",
    "",
    text,
    count=1,
    flags=re.S,
)
text = re.sub(
    r"/// 将（可编辑后的）同步 SQL 写入缓存目录.*?\npub fn save_sync_sql_file\(app: &Arc<dyn DbSyncEventSink>, sql: &str\) -> Result<String, String> \{\s*write_sync_sql_file\(app, sql\)\s*\}\n",
    "pub use crate::paths::{read_sync_sql_file, save_sync_sql_file};\n",
    text,
    flags=re.S,
)
text = re.sub(
    r"pub fn read_sync_sql_file\(app: &Arc<dyn DbSyncEventSink>.*?\n}\n",
    "",
    text,
    count=1,
    flags=re.S,
)

# row diff cache 无 app 参数
text = re.sub(r"save_row_diff_cache\(app, ", "save_row_diff_cache(", text)
text = re.sub(r"load_row_diff_cache_all\(app, ", "load_row_diff_cache_all(", text)

# generate_data_sync_sql_script 去掉 app
text = re.sub(
    r"pub async fn generate_data_sync_sql_script\(\n    app: &Arc<dyn DbSyncEventSink>,\n",
    "pub async fn generate_data_sync_sql_script(\n",
    text,
)

header = """use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use omnipanel_store::DbConnectionConfig;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db_ops;
use crate::event::{BgTaskDbEvent, DbSyncEventSink, SyncExecResultEvent};
use crate::row_diff_cache::{build_row_diff_cache_id, load_row_diff_cache_all, save_row_diff_cache};
use crate::util::default_worker_count;
use omnipanel_db::{DbColumnMeta, DbIndexMeta};

"""

idx = text.find("const PAGE_SIZE")
if idx < 0:
    raise SystemExit("PAGE_SIZE not found")
text = header + text[idx:]

out = ROOT / "crates/omnipanel-db-sync/src/jobs.rs"
out.write_text(text, encoding="utf-8")
print(f"wrote {out} ({len(text)} bytes)")

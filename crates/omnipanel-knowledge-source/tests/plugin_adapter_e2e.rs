//! knowledge-starter 样板经真实 QuickJS 驱动：L2 契约可执行，runner 能消费。
//!
//! 覆盖整条插件路径：`logic.js`（QuickJS）→ `PluginAdapter`
//! → 通用同步引擎 → 知识库条目。

use std::sync::{Arc, Mutex};

use omnipanel_knowledge_source::{MethodCaller, PluginAdapter, rebuild_source, sync_source};
use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor, PluginLogicInstance};
use omnipanel_plugin_js::JsExecutor;

const LOGIC_JS: &str = include_str!("../../../plugins-samples/knowledge-starter/logic.js");

struct NoopBridge;

impl PluginHostBridge for NoopBridge {}

struct QuickCaller {
    inst: Arc<Mutex<Box<dyn PluginLogicInstance>>>,
}

impl MethodCaller for QuickCaller {
    fn call(
        &self,
        plugin_id: &str,
        method: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        assert_eq!(plugin_id, "omni.sample.knowledge-starter");
        let args_json = serde_json::to_string(&args).map_err(|e| e.to_string())?;
        let inst = Arc::clone(&self.inst);
        let method = method.to_string();
        // 同步契约内桥接异步 QuickJS（多线程 runtime 下 block_in_place）。
        let out = tokio::task::block_in_place(move || {
            tokio::runtime::Handle::current().block_on(async move {
                let guard = inst.lock().map_err(|e| e.to_string())?;
                guard
                    .call(&method, &args_json)
                    .await
                    .map_err(|e| e.to_string())
            })
        })
        .map_err(|e| e.to_string())?;
        serde_json::from_str(&out).map_err(|e| e.to_string())
    }
}

fn instantiate() -> Arc<Mutex<Box<dyn PluginLogicInstance>>> {
    let inst = JsExecutor::new()
        .instantiate(
            "omni.sample.knowledge-starter",
            &LogicPackage::Js(LOGIC_JS.as_bytes().to_vec()),
            Arc::new(NoopBridge),
        )
        .expect("样板实例化失败");
    Arc::new(Mutex::new(inst))
}

fn adapter() -> PluginAdapter<QuickCaller> {
    let caller = QuickCaller {
        inst: instantiate(),
    };
    PluginAdapter::new(
        "omni.sample.knowledge-starter",
        "demo",
        "listNotebooks",
        "getDocument",
        "listDocuments",
        caller,
    )
}

fn mem_storage() -> omnipanel_store::Storage {
    omnipanel_store::Storage::open_in_memory().expect("内存库")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sample_plugin_drives_full_sync() {
    let storage = mem_storage();
    let adapter = adapter();

    let report = sync_source(&storage, &adapter, "演示").expect("同步应成功");
    assert_eq!((report.scanned, report.added), (1, 1));
    assert!(report.failed.is_empty());

    let entry = storage
        .get_knowledge("ks-doc-doc-hello")
        .expect("读条目")
        .expect("文档应入库");
    assert_eq!(entry.title, "你好，知识源");
    assert!(entry.content.contains("knowledge"));
    assert_eq!(entry.parent_id, "ks-box-nb-demo");
    assert!(entry.tags.contains(&"demo".to_string()));
    assert!(entry.source.starts_with("import:ks:demo:"));

    let folder = storage
        .get_knowledge("ks-box-nb-demo")
        .expect("读文件夹")
        .expect("笔记本应在库");
    assert_eq!(folder.node_type, "folder");

    // 二轮幂等（样板 updatedAt=0，指纹稳定）。
    let report = sync_source(&storage, &adapter, "演示").expect("二轮");
    assert_eq!((report.added, report.updated), (0, 0));

    // 重建恢复。
    storage
        .delete_knowledge("ks-doc-doc-hello")
        .expect("丢文档");
    let report = rebuild_source(&storage, &adapter, "演示").expect("重建");
    assert_eq!(report.added, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_method_surfaces_contract_error() {
    let storage = mem_storage();
    let caller = QuickCaller {
        inst: instantiate(),
    };
    let bad = PluginAdapter::new(
        "omni.sample.knowledge-starter",
        "demo",
        "nope",
        "getDocument",
        "listDocuments",
        caller,
    );
    let err = sync_source(&storage, &bad, "演示").expect_err("未知方法应失败");
    assert!(
        err.to_string().contains("UnknownMethod"),
        "契约错误应透出: {err}"
    );
}

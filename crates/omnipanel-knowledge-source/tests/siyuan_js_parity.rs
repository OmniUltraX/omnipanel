//! 思源 JS 解析与 Rust 原生实现对齐测试：真实 QuickJS 驱动 logic.js。
//!
//! 形状 pin 自线上语料（标题/引用/代码/有序列表/链接/公式/表格/未知块）。

use std::sync::{Arc, Mutex};

use omnipanel_knowledge_source::MethodCaller;
use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor, PluginLogicInstance};

const LOGIC_JS: &str = include_str!("../../../plugins-market/knowledge-siyuan/logic.js");

struct NoopBridge;

impl PluginHostBridge for NoopBridge {}

fn call_js(method: &str, args: serde_json::Value) -> serde_json::Value {
    let inst = JsExecutorScope::new();
    inst.call(method, args)
}

struct JsExecutorScope;

impl JsExecutorScope {
    fn new() -> Self {
        Self
    }

    fn try_call(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        use omnipanel_plugin_js::JsExecutor;
        let inst = JsExecutor::new()
            .instantiate(
                "omni.knowledge.siyuan",
                &LogicPackage::Js(LOGIC_JS.as_bytes().to_vec()),
                Arc::new(NoopBridge),
            )
            .map_err(|e| e.to_string())?;
        let inst = Arc::new(Mutex::new(inst));
        let args_json = serde_json::to_string(&args).map_err(|e| e.to_string())?;
        let method = method.to_string();
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

    fn call(&self, method: &str, args: serde_json::Value) -> serde_json::Value {
        self.try_call(method, args).expect("QuickJS 调用失败")
    }
}

const SY_DOC: &str = r###"{"ID":"doc1","Spec":"2","Type":"NodeDocument","Properties":{"id":"doc1","title":"周报"},"Children":[
{"ID":"h1","Type":"NodeHeading","HeadingLevel":2,"Children":[{"Type":"NodeHeadingC8hMarker","Data":"## "},{"Type":"NodeText","Data":"本周进展"}]},
{"ID":"p1","Type":"NodeParagraph","Children":[{"Type":"NodeText","Data":"完成了同步"}]},
{"ID":"q1","Type":"NodeBlockquote","Children":[{"Type":"NodeBlockquoteMarker","Data":"> "},{"ID":"qp1","Type":"NodeParagraph","Children":[{"Type":"NodeText","Data":"引用内容"}]}]},
{"ID":"c1","Type":"NodeCodeBlock","IsFencedCodeBlock":true,"Children":[{"Type":"NodeCodeBlockFenceOpenMarker","Data":"```"},{"Type":"NodeCodeBlockFenceInfoMarker","CodeBlockInfo":"Y29uZg=="},{"Type":"NodeCodeBlockCode","Data":"a = 1\n"},{"Type":"NodeCodeBlockFenceCloseMarker","Data":"```"}]},
{"ID":"l1","Type":"NodeList","Children":[{"ID":"li1","Type":"NodeListItem","ListData":{"Marker":"MS4="},"Children":[{"ID":"lp1","Type":"NodeParagraph","Children":[{"Type":"NodeTextMark","TextMarkType":"a","TextMarkAHref":"https://example.com/x","TextMarkTextContent":"链接文本"}]}]}]},
{"ID":"m1","Type":"NodeParagraph","Children":[{"Type":"NodeTextMark","TextMarkType":"inline-math","TextMarkInlineMathContent":"x^2"}]},
{"ID":"t1","Type":"NodeTable","Children":[{"ID":"tr1","Type":"NodeTableRow","Children":[{"ID":"c1","Type":"NodeTableCell","Children":[{"Type":"NodeText","Data":"A"}]},{"ID":"c2","Type":"NodeTableCell","Children":[{"Type":"NodeText","Data":"B"}]}]}]},
{"ID":"x1","Type":"NodeFuture","Children":[{"Type":"NodeText","Data":"未来块"}]}
]}"###;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn js_parses_sy_like_native() {
    let scope = JsExecutorScope::new();
    let ret = scope.call(
        "parseDocument",
        serde_json::json!({ "relPath": "box1/doc1.sy", "content": SY_DOC }),
    );
    assert_eq!(ret["kind"], "doc");
    assert_eq!(ret["id"], "doc1");
    assert_eq!(ret["title"], "周报");
    let md = ret["markdown"].as_str().expect("markdown 字符串");
    for fragment in [
        "## 本周进展",
        "完成了同步",
        "> 引用内容",
        "```conf\na = 1\n```",
        "1. [链接文本](https://example.com/x)",
        "$x^2$",
        "A | B",
        "未来块",
    ] {
        assert!(md.contains(fragment), "缺片段 {fragment}:\n{md}");
    }
}

const SY_IMG_TAG_DOC: &str = r###"{"ID":"doc2","Spec":"2","Type":"NodeDocument","Properties":{"id":"doc2","title":"图文","tags":"cnb,personal"},"Children":[
{"ID":"p1","Type":"NodeParagraph","Children":[{"Type":"NodeImage","Data":"span","Children":[{"Type":"NodeBang"},{"Type":"NodeOpenBracket"},{"Type":"NodeLinkText","Data":"eb5a608c"},{"Type":"NodeCloseBracket"},{"Type":"NodeOpenParen"},{"Type":"NodeLinkDest","Data":"assets/eb5a608c-20250612-ibnfbr1.jpg"},{"Type":"NodeCloseParen"}]}]},
{"ID":"p2","Type":"NodeParagraph","Children":[{"Type":"NodeText","Data":"喜欢 "},{"Type":"NodeTextMark","TextMarkType":"tag","TextMarkTextContent":"sport"}]}
]}"###;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn js_renders_images_and_collects_tags() {
    let scope = JsExecutorScope::new();
    let ret = scope.call(
        "parseDocument",
        serde_json::json!({ "relPath": "box1/doc2.sy", "content": SY_IMG_TAG_DOC }),
    );
    assert_eq!(ret["kind"], "doc");
    let md = ret["markdown"].as_str().expect("markdown 字符串");
    assert!(
        md.contains("![eb5a608c](assets/eb5a608c-20250612-ibnfbr1.jpg)"),
        "图片应为标准 markdown 语法:\n{md}"
    );
    let tags = ret["tags"].as_array().expect("tags 数组");
    let tags: Vec<&str> = tags.iter().filter_map(|v| v.as_str()).collect();
    assert!(tags.contains(&"cnb"), "文档属性标签: {tags:?}");
    assert!(tags.contains(&"personal"), "文档属性标签: {tags:?}");
    assert!(tags.contains(&"sport"), "行内标签: {tags:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn js_routes_conf_and_skips() {
    let scope = JsExecutorScope::new();
    let conf = scope.call(
        "parseDocument",
        serde_json::json!({
            "relPath": "box1/.siyuan/conf.json",
            "content": "{\"name\":\"工作笔记\"}",
        }),
    );
    assert_eq!(conf["kind"], "notebook");
    assert_eq!(conf["id"], "box1");
    assert_eq!(conf["name"], "工作笔记");

    let skipped = scope.call(
        "parseDocument",
        serde_json::json!({ "relPath": "box1/a.png", "content": "" }),
    );
    assert_eq!(skipped["kind"], "skip");

    let err = scope
        .try_call(
            "parseDocument",
            serde_json::json!({ "relPath": "box1/bad.sy", "content": "{oops" }),
        )
        .expect_err("坏 JSON 应进失败列表");
    assert!(err.contains("解析 .sy 失败"), "错误可读并可归因: {err}");
}

#[allow(dead_code)]
struct TestCaller;
impl MethodCaller for TestCaller {
    fn call(
        &self,
        _plugin_id: &str,
        _method: &str,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("stub".to_string())
    }
}

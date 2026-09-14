//! 思源 `.sy` 文档解析：块树 → Markdown。
//!
//! 以当前 Spec 2 PascalCase AST 为主（`ID`/`Type`/`Properties`/`Children`，
//! 行内 `Data` 拼接即 Markdown），旧 camelCase 格式（`content`/`markdown`/`ial`）
//! 通过字段别名兼容，走同一套组装引擎。
//!
//! 组装规则：
//! - 有 ID 的节点是结构块，无 ID 的是行内/标记，直接拼 `Data`；
//! - 结构子块若子树全行内（如引用里的段落），并入当前行；否则另起块
//!   （嵌套列表压平缩进，表格行内用 `|` 连接——内容保留、排版降级）；
//! - `NodeCodeBlock` 显式处理（围栏 + base64 信息串解码，失败取原文）；
//! - 未知块类型不特殊处理，整篇不炸。

use serde::Deserialize;

/// 思源块属性（新格式小写字段；旧格式无此结构，默认空）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SyProperties {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub updated: String,
}

/// 思源块（新旧格式字段并存，未知字段忽略以容忍版本差异）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SyNode {
    #[serde(default, alias = "ID")]
    pub id: String,
    #[serde(default, rename = "type", alias = "Type")]
    pub block_type: String,
    #[serde(default, alias = "SubType")]
    pub subtype: String,
    /// 新格式标题级别（`HeadingLevel`）。
    #[serde(default, alias = "HeadingLevel")]
    pub heading_level: i64,
    /// 行内/标记文本（新格式 `Data`）。
    #[serde(default, alias = "Data")]
    pub data: String,
    /// 代码块语言（base64，`CodeBlockInfo`，块节点与信息标记共用键名）。
    #[serde(default, alias = "CodeBlockInfo")]
    pub code_info: String,
    /// 块级围栏（部分版本直接挂在 `NodeCodeBlock` 上）。
    #[serde(default, alias = "CodeBlockOpenFence")]
    pub code_open: String,
    #[serde(default, alias = "CodeBlockCloseFence")]
    pub code_close: String,
    /// 行内标记（链接/公式等，`NodeTextMark`）。
    #[serde(default, alias = "TextMarkType")]
    pub text_mark_type: String,
    #[serde(default, alias = "TextMarkTextContent")]
    pub text_mark_text: String,
    #[serde(default, alias = "TextMarkAHref")]
    pub text_mark_href: String,
    #[serde(default, alias = "TextMarkInlineMathContent")]
    pub text_mark_math: String,
    /// 列表元数据（`ListData.Marker` 为 base64 序号，如 `MS4=` → `1.`）。
    #[serde(default, alias = "ListData")]
    pub list_data: SyListData,
    #[serde(default, alias = "Properties")]
    pub properties: SyProperties,
    #[serde(default, alias = "Children")]
    pub children: Vec<SyNode>,
    // 旧格式字段（新格式缺省为空，走同一引擎）。
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub markdown: String,
    #[serde(default)]
    pub ial: String,
}

/// 列表元数据（有序序号等）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SyListData {
    #[serde(default, alias = "Marker")]
    pub marker: String,
}

/// 思源文档根（`.sy` 文件顶层）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SyDoc {
    #[serde(default, alias = "ID")]
    pub id: String,
    #[serde(default, rename = "type", alias = "Type")]
    pub block_type: String,
    #[serde(default, alias = "Properties")]
    pub properties: SyProperties,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub ial: String,
    #[serde(default, alias = "Children")]
    pub children: Vec<SyNode>,
}

// 兼容旧测试/调用：块即节点。
pub type SyBlock = SyNode;

/// 解析 `.sy` 文件正文。失败返回人类可读错误（调用方记入同步失败列表，不中断整批）。
pub fn parse_sy_doc(text: &str) -> Result<SyDoc, String> {
    serde_json::from_str(text).map_err(|e| format!("解析 .sy 失败: {e}"))
}

/// 节点自身文本：行内标记（链接/公式）→ 新 `Data` → 旧 `markdown` → 旧 `content`。
/// 注意不 trim：标记后的空格（如 `"## "`）靠拼接保留，落块时统一 trim。
/// 返回 `None` 表示软/硬换行（调用方转 `\n`）。
fn own_text(node: &SyNode) -> Option<String> {
    if !node.text_mark_text.trim().is_empty() {
        let text = node.text_mark_text.trim().to_string();
        if node.text_mark_type == "a" && !node.text_mark_href.trim().is_empty() {
            return Some(format!("[{}]({})", text, node.text_mark_href.trim()));
        }
        return Some(text);
    }
    if !node.text_mark_math.trim().is_empty() {
        return Some(format!("${}$", node.text_mark_math.trim()));
    }
    if !node.data.is_empty() {
        return Some(node.data.clone());
    }
    if !node.markdown.is_empty() {
        return Some(node.markdown.clone());
    }
    if !node.content.is_empty() {
        return Some(node.content.clone());
    }
    None
}

/// 行内拼接：自身文本 + 无 ID 后代的文本（标记与行内格式原样保留）。
fn inline_into(node: &SyNode, buf: &mut String) {
    match node.block_type.as_str() {
        "NodeSoftBreak" => buf.push('\n'),
        "NodeHardBreak" => buf.push_str("  \n"),
        _ => {}
    }
    if let Some(own) = own_text(node) {
        buf.push_str(&own);
    }
    for child in &node.children {
        if child.id.is_empty() {
            inline_into(child, buf);
        }
    }
}

/// 子树是否全行内（自身或后代无带 ID 的结构块）。
fn subtree_inline(node: &SyNode) -> bool {
    node.children
        .iter()
        .all(|c| c.id.is_empty() && subtree_inline(c))
}

/// 表格行：单元格并入一行，用 `|` 连接（含无 ID 单元格的直接文本）。
fn render_table_row(node: &SyNode) -> String {
    let mut cells = Vec::new();
    // 无 ID 子节点（少见）：直接行内文本也参与。
    let mut loose = String::new();
    for child in &node.children {
        if child.id.is_empty() {
            inline_into(child, &mut loose);
            continue;
        }
        let mut buf = String::new();
        inline_into(child, &mut buf);
        let cell = buf.trim().to_string();
        if !cell.is_empty() {
            cells.push(cell);
        }
    }
    if !loose.trim().is_empty() {
        cells.push(loose.trim().to_string());
    }
    cells.join(" | ")
}

fn decode_code_info(info: &str) -> String {
    let raw = info.trim();
    if raw.is_empty() {
        return String::new();
    }
    use base64::Engine;
    match base64::engine::general_purpose::STANDARD.decode(raw) {
        Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| raw.to_string()),
        Err(_) => raw.to_string(),
    }
}

fn find_child<'a>(node: &'a SyNode, types: &[&str]) -> Option<&'a SyNode> {
    node.children
        .iter()
        .find(|c| types.iter().any(|t| c.block_type == *t))
}

fn render_code_block(node: &SyNode) -> String {
    // 新版本围栏可直接挂在块节点上，优先用；否则回退标记子节点。
    let block_text = |types: &[&str]| -> String {
        find_child(node, types)
            .map(|c| {
                let mut buf = String::new();
                inline_into(c, &mut buf);
                buf
            })
            .unwrap_or_default()
    };
    let open = if !node.code_open.is_empty() {
        node.code_open.clone()
    } else {
        block_text(&["NodeCodeBlockFenceOpenMarker"])
    };
    let close = if !node.code_close.is_empty() {
        node.code_close.clone()
    } else {
        block_text(&["NodeCodeBlockFenceCloseMarker"])
    };
    let info = if !node.code_info.is_empty() {
        decode_code_info(&node.code_info)
    } else {
        find_child(node, &["NodeCodeBlockFenceInfoMarker"])
            .map(|c| decode_code_info(&c.code_info))
            .unwrap_or_default()
    };
    let code = block_text(&["NodeCodeBlockCode", "NodeCodeBlockCodeMarker"]);
    let code = code.trim_matches('\n');
    if open.is_empty() && close.is_empty() && code.is_empty() && info.is_empty() {
        return String::new();
    }
    let open = if open.trim().is_empty() {
        "```"
    } else {
        open.trim()
    };
    let close = if close.trim().is_empty() {
        "```"
    } else {
        close.trim()
    };
    format!("{open}{info}\n{code}\n{close}")
}

/// 列表项前缀：有序序号（`ListData.Marker` base64，如 `MS4=` → `1.`），缺省 `- `。
fn list_item_prefix(node: &SyNode) -> String {
    let marker = node.list_data.marker.trim();
    if marker.is_empty() {
        return "- ".to_string();
    }
    use base64::Engine;
    match base64::engine::general_purpose::STANDARD.decode(marker) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) if !text.trim().is_empty() => format!("{} ", text.trim()),
            _ => "- ".to_string(),
        },
        Err(_) => "- ".to_string(),
    }
}

fn is_table_row(node_type: &str) -> bool {
    matches!(
        node_type,
        "NodeTableRow" | "NodeTableHead" | "NodeTableRowHead"
    )
}

/// 结构块产出块级字符串（带缓冲的 pending 行并入）。
fn collect_units(node: &SyNode, out: &mut Vec<String>, pending: &mut String) {
    if node.block_type == "NodeCodeBlock" {
        let code = render_code_block(node);
        if !code.is_empty() {
            if !pending.trim().is_empty() {
                out.push(pending.trim().to_string());
                pending.clear();
            }
            out.push(code);
        }
        return;
    }
    if is_table_row(&node.block_type) {
        let row = render_table_row(node);
        if !row.is_empty() {
            if !pending.trim().is_empty() {
                out.push(pending.trim().to_string());
                pending.clear();
            }
            out.push(row);
        }
        // 行内残留的结构子块继续递归（极少见，防丢）。
        for child in &node.children {
            if !child.id.is_empty() && !subtree_inline(child) {
                collect_units(child, out, &mut String::new());
            }
        }
        return;
    }
    // 通用：自身行内 + 全行内的结构子块并入当前行；容器子块另起。
    // 列表项先放序号前缀（有序解码 Marker，无序 `- `）。
    let mut buf = std::mem::take(pending);
    if node.block_type == "NodeListItem" {
        buf.push_str(&list_item_prefix(node));
    }
    inline_into(node, &mut buf);
    // inline_into 已含无 ID 后代；这里只处理带 ID 子块。
    for child in &node.children {
        if child.id.is_empty() {
            continue;
        }
        if subtree_inline(child) {
            let mut piece = String::new();
            inline_into(child, &mut piece);
            buf.push_str(&piece);
        } else {
            if !buf.trim().is_empty() {
                out.push(buf.trim().to_string());
                buf = String::new();
            }
            collect_units(child, out, &mut String::new());
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf.trim().to_string());
    }
}

/// 块树拼 Markdown：顶层结构块按文档序以空行连接。
pub fn doc_markdown(doc: &SyDoc) -> String {
    let mut out = Vec::new();
    let mut pending = String::new();
    for child in &doc.children {
        if child.id.is_empty() {
            inline_into(child, &mut pending);
            continue;
        }
        collect_units(child, &mut out, &mut pending);
    }
    if !pending.trim().is_empty() {
        out.push(pending.trim().to_string());
    }
    out.join("\n\n")
}

/// 从 IAL（如 `{: title="..." updated="..."}`）里取 `title` 属性（旧格式兜底）。
fn ial_title(ial: &str) -> Option<String> {
    let marker = "title=\"";
    let start = ial.find(marker)? + marker.len();
    let rest = &ial[start..];
    let end = rest.find('"')?;
    let title = rest[..end].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

fn first_heading_content(nodes: &[SyNode]) -> Option<String> {
    for node in nodes {
        if node.block_type == "NodeHeading" {
            let mut buf = String::new();
            inline_into(node, &mut buf);
            // 去掉标记前缀（如 "# "）。
            let text = buf.trim().trim_start_matches(['#', '>', '-', '*']).trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
        if let Some(found) = first_heading_content(&node.children) {
            return Some(found);
        }
    }
    None
}

/// 文档标题：`Properties.title` → 根 content → IAL title → 首个标题块 → 文件名兜底。
pub fn doc_title(doc: &SyDoc, fallback: &str) -> String {
    let prop_title = doc.properties.title.trim();
    if !prop_title.is_empty() {
        return prop_title.to_string();
    }
    let content = doc.content.trim();
    if !content.is_empty() {
        return content.to_string();
    }
    if let Some(title) = ial_title(&doc.ial) {
        return title;
    }
    if let Some(heading) = first_heading_content(&doc.children) {
        return heading;
    }
    fallback.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 真实 Spec 2 形状（字段名/嵌套按线上文件 pin）。
    const SAMPLE_NEW: &str = r###"{
        "ID": "doc1", "Spec": "2", "Type": "NodeDocument",
        "Properties": {"id": "doc1", "title": "周报", "type": "doc", "updated": "20240101120000"},
        "Children": [
            {"ID": "h1", "Type": "NodeHeading", "HeadingLevel": 2,
             "Properties": {"id": "h1", "updated": "20240101120000"},
             "Children": [{"Type": "NodeHeadingC8hMarker", "Data": "## "}, {"Type": "NodeText", "Data": "本周进展"}]},
            {"ID": "p1", "Type": "NodeParagraph",
             "Properties": {"id": "p1", "updated": "20240101120000"},
             "Children": [{"Type": "NodeText", "Data": "完成了同步"}]},
            {"ID": "q1", "Type": "NodeBlockquote",
             "Properties": {"id": "q1", "updated": "20240101120000"},
             "Children": [{"Type": "NodeBlockquoteMarker", "Data": "> "},
                 {"ID": "qp1", "Type": "NodeParagraph",
                  "Properties": {"id": "qp1", "updated": "20240101120000"},
                  "Children": [{"Type": "NodeText", "Data": "引用内容"}]}]},
            {"ID": "c1", "Type": "NodeCodeBlock", "IsFencedCodeBlock": true,
             "Properties": {"id": "c1", "updated": "20240101120000"},
             "Children": [{"Type": "NodeCodeBlockFenceOpenMarker", "Data": "```"},
                 {"Type": "NodeCodeBlockFenceInfoMarker", "CodeBlockInfo": "Y29uZg=="},
                 {"Type": "NodeCodeBlockCode", "Data": "a = 1\n"},
                 {"Type": "NodeCodeBlockFenceCloseMarker", "Data": "```"}]},
            {"ID": "x1", "Type": "NodeSomethingNew",
             "Properties": {"id": "x1", "updated": "20240101120000"},
             "Children": [{"Type": "NodeText", "Data": "未来块"}]}
        ]
    }"###;

    // 旧 camelCase 形状（兼容路径）。
    const SAMPLE_OLD: &str = r###"{
        "id": "doc-old", "type": "NodeDocument", "content": "",
        "ial": "{: title=\"旧文档\" updated=\"20240101120000\"}",
        "children": [
            {"id": "b1", "type": "NodeParagraph", "content": "旧正文", "markdown": "旧正文", "children": []}
        ]
    }"###;

    #[test]
    fn new_format_assembles_markdown() {
        let doc = parse_sy_doc(SAMPLE_NEW).expect("新格式应可解析");
        assert_eq!(doc_title(&doc, "fallback"), "周报");
        let md = doc_markdown(&doc);
        assert!(md.contains("## 本周进展"), "标题保留: {md}");
        assert!(md.contains("完成了同步"), "段落保留: {md}");
        assert!(md.contains("> 引用内容"), "引用合并为一行: {md}");
        assert!(md.contains("```conf\na = 1\n```"), "代码块还原: {md}");
        assert!(md.contains("未来块"), "未知块降级: {md}");
    }

    #[test]
    fn old_format_still_works() {
        let doc = parse_sy_doc(SAMPLE_OLD).expect("旧格式应可解析");
        assert_eq!(doc_title(&doc, "fallback"), "旧文档");
        assert!(doc_markdown(&doc).contains("旧正文"));
    }

    #[test]
    fn title_falls_back_chain() {
        let mut doc = parse_sy_doc(SAMPLE_NEW).expect("样例应可解析");
        doc.properties.title = String::new();
        assert_eq!(doc_title(&doc, "fallback"), "本周进展");
        doc.children.clear();
        assert_eq!(doc_title(&doc, "fallback"), "fallback");
    }

    #[test]
    fn invalid_json_is_human_readable_error() {
        let err = parse_sy_doc("{oops").expect_err("非法 JSON 应失败");
        assert!(err.contains("解析 .sy 失败"), "错误可读: {err}");
    }

    // 链接标记 + 行内公式 + 有序列表（线上真实形状）。
    const SAMPLE_MARKS: &str = r###"{
        "ID": "doc2", "Type": "NodeDocument",
        "Properties": {"title": "民宿系统调研"},
        "Children": [
            {"ID": "l1", "Type": "NodeList", "ListData": {"Typ": 1},
             "Children": [
                {"ID": "li1", "Type": "NodeListItem",
                 "ListData": {"Typ": 1, "Marker": "MS4="},
                 "Children": [
                    {"ID": "p1", "Type": "NodeParagraph",
                     "Children": [{"Type": "NodeTextMark", "TextMarkType": "a",
                        "TextMarkAHref": "https://example.com/x",
                        "TextMarkTextContent": "fastadmin开源代码"}]}
                 ]}
             ]},
            {"ID": "p2", "Type": "NodeParagraph",
             "Children": [{"Type": "NodeTextMark", "TextMarkType": "inline-math",
                "TextMarkInlineMathContent": "x^2"}]}
        ]
    }"###;

    #[test]
    fn link_math_and_ordered_list() {
        let doc = parse_sy_doc(SAMPLE_MARKS).expect("标记样例应可解析");
        assert_eq!(doc_title(&doc, "fallback"), "民宿系统调研");
        let md = doc_markdown(&doc);
        assert!(
            md.contains("1. [fastadmin开源代码](https://example.com/x)"),
            "有序序号+链接: {md}"
        );
        assert!(md.contains("$x^2$"), "行内公式: {md}");
    }
}

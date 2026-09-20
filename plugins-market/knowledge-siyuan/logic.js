// 思源知识源 L2 逻辑：本地文件解析（宿主遍历授权目录，逐文件调 parseDocument）。
//
// parseDocument({ relPath, content }) →
//   { kind: "notebook", id, name }                 // <box>/.siyuan/conf.json
//   { kind: "doc", id, title, markdown, tags }     // *.sy（Spec 2 PascalCase AST 为主，旧格式兼容）
//   { kind: "skip" }                               // 其他文件
//
// 组装规则与宿主 runner 同格式约定（id/source/tag 见 plugin.json 上游文档）：
// 行内 Data 拼接、链接/公式标记、图片 ![alt](dest)、代码围栏、表格 | 连接、
// 列表序号、未知块降级；标签来自文档 Properties.tags + 行内 tag 标记。

function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}

function str(v) {
  return v == null ? "" : String(v);
}

function pick(node, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = node[keys[i]];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function nodeId(node) { return str(node.ID || node.id); }
function nodeType(node) { return str(node.Type || node.type); }
function nodeChildren(node) {
  var c = node.Children || node.children;
  return Array.isArray(c) ? c : [];
}
function nodeProps(node) {
  var p = node.Properties;
  if (p && typeof p === "object") return p;
  return {};
}

// base64 解码（QuickJS 无 atob，自带最小实现；容错，失败返回原文）。
var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function b64decode(input) {
  var s = String(input || "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!s) return "";
  var out = [];
  var i = 0;
  try {
    while (i < s.length) {
      var e1 = B64CHARS.indexOf(s.charAt(i++));
      var e2 = B64CHARS.indexOf(s.charAt(i++));
      var e3 = B64CHARS.indexOf(s.charAt(i++));
      var e4 = B64CHARS.indexOf(s.charAt(i++));
      if (e1 < 0 || e2 < 0) break;
      var n = (e1 << 18) | (e2 << 12) | ((e3 & 63) << 6) | (e4 & 63);
      out.push(String.fromCharCode((n >> 16) & 255));
      if (e3 !== 64) out.push(String.fromCharCode((n >> 8) & 255));
      if (e4 !== 64) out.push(String.fromCharCode(n & 255));
    }
  } catch (e) { return String(input || ""); }
  // UTF-8 还原（ASCII 直接可用；失败回退原文）。
  try {
    return decodeURIComponent(escape(out.join("")));
  } catch (e) {
    return out.join("");
  }
}

// 节点自身文本：行内标记 → Data → markdown → content。
// TextMarkType 可能是复合标记（"strong a"），按 token 判定：链接优先成链，
// 粗斜体包外层；tag 标记原文保留（索引另收）；code 走反引号。
function ownText(node) {
  var markText = str(node.TextMarkTextContent);
  if (markText.trim() !== "") {
    var tokens = str(node.TextMarkType).split(" ");
    var has = function (s) {
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i] === s) return true;
      }
      return false;
    };
    if (has("tag")) return markText;
    var href = str(node.TextMarkAHref).trim();
    var text = markText.trim();
    if (has("a") && href !== "") {
      text = "[" + text + "](" + href + ")";
    }
    if (has("code") && !has("a")) return "`" + markText.trim() + "`";
    if (has("strong")) text = "**" + text + "**";
    else if (has("em")) text = "*" + text + "*";
    if (has("strike") || has("s")) text = "~~" + text + "~~";
    return text;
  }
  var math = str(node.TextMarkInlineMathContent);
  if (math.trim() !== "") return "$" + math.trim() + "$";
  if (str(node.Data) !== "") return str(node.Data);
  if (str(node.markdown) !== "") return str(node.markdown);
  if (str(node.content) !== "") return str(node.content);
  return "";
}

function isStructural(node) {
  return nodeId(node) !== "";
}

function inlineInto(node, buf) {
  var t = nodeType(node);
  if (t === "NodeSoftBreak") { buf.push("\n"); return; }
  if (t === "NodeHardBreak") { buf.push("  \n"); return; }
  if (t === "NodeImage") { buf.push(renderImage(node)); return; }
  var own = ownText(node);
  if (own !== "") buf.push(own);
  var kids = nodeChildren(node);
  for (var i = 0; i < kids.length; i++) {
    if (!isStructural(kids[i])) inlineInto(kids[i], buf);
  }
}

// 图片：NodeImage 下 NodeLinkText=alt、NodeLinkDest=dest（通常 assets/…）。
// dest 原样保留（宿主同步期改写为 knowledge-asset://），alt 为空也照出图。
function renderImage(node) {
  var alt = "";
  var dest = "";
  var kids = nodeChildren(node);
  for (var i = 0; i < kids.length; i++) {
    var kt = nodeType(kids[i]);
    if (kt === "NodeLinkText" && alt === "") alt = str(kids[i].Data);
    if (kt === "NodeLinkDest" && dest === "") dest = str(kids[i].Data).trim();
  }
  if (dest === "") {
    // 降级：子节点文本兜底（旧语料可能只有文本）。
    var buf = [];
    for (var j = 0; j < kids.length; j++) {
      if (!isStructural(kids[j])) inlineInto(kids[j], buf);
    }
    return buf.join("");
  }
  return "![" + alt + "](" + dest + ")";
}

function subtreeInline(node) {
  var kids = nodeChildren(node);
  for (var i = 0; i < kids.length; i++) {
    if (isStructural(kids[i])) return false;
    if (!subtreeInline(kids[i])) return false;
  }
  return true;
}

function findChild(node, types) {
  var kids = nodeChildren(node);
  for (var i = 0; i < kids.length; i++) {
    for (var j = 0; j < types.length; j++) {
      if (nodeType(kids[i]) === types[j]) return kids[i];
    }
  }
  return null;
}

function decodeCodeInfo(info) {
  var raw = str(info).trim();
  if (!raw) return "";
  var decoded = b64decode(raw);
  return decoded !== "" ? decoded : raw;
}

function renderCodeBlock(node) {
  function childText(types) {
    var c = findChild(node, types);
    if (!c) return "";
    var buf = [];
    inlineInto(c, buf);
    return buf.join("");
  }
  var open = str(node.CodeBlockOpenFence) !== "" ? node.CodeBlockOpenFence : childText(["NodeCodeBlockFenceOpenMarker"]);
  var close = str(node.CodeBlockCloseFence) !== "" ? node.CodeBlockCloseFence : childText(["NodeCodeBlockFenceCloseMarker"]);
  var infoNode = findChild(node, ["NodeCodeBlockFenceInfoMarker"]);
  var info = str(node.CodeBlockInfo) !== ""
    ? decodeCodeInfo(node.CodeBlockInfo)
    : (infoNode ? decodeCodeInfo(infoNode.CodeBlockInfo) : "");
  var codeNode = findChild(node, ["NodeCodeBlockCode", "NodeCodeBlockCodeMarker"]);
  var code = "";
  if (codeNode) {
    var buf = [];
    inlineInto(codeNode, buf);
    code = buf.join("").replace(/^\n+|\n+$/g, "");
  }
  if (!open && !close && !code && !info) return "";
  if (!open.trim()) open = "```";
  if (!close.trim()) close = "```";
  return open.trim() + info + "\n" + code + "\n" + close.trim();
}

function isTableRow(t) {
  return t === "NodeTableRow" || t === "NodeTableHead" || t === "NodeTableRowHead";
}

function renderTableRow(node) {
  var cells = [];
  var loose = [];
  var kids = nodeChildren(node);
  for (var i = 0; i < kids.length; i++) {
    if (!isStructural(kids[i])) {
      inlineInto(kids[i], loose);
      continue;
    }
    var buf = [];
    inlineInto(kids[i], buf);
    var cell = buf.join("").trim();
    if (cell !== "") cells.push(cell);
  }
  var looseText = loose.join("").trim();
  if (looseText !== "") cells.push(looseText);
  return cells.join(" | ");
}

function listItemPrefix(node) {
  var marker = str(node.ListData && node.ListData.Marker).trim();
  if (!marker) return "- ";
  var decoded = b64decode(marker).trim();
  return decoded !== "" ? decoded + " " : "- ";
}

function collectUnits(node, out, pending) {
  var t = nodeType(node);
  if (t === "NodeHeading") {
    var heading = renderHeading(node);
    if (heading !== "") {
      var pendingHead = pending.join("").trim();
      if (pendingHead !== "") {
        out.push(pendingHead);
        pending.length = 0;
      }
      out.push(heading);
    }
    var hkids = nodeChildren(node);
    for (var hi = 0; hi < hkids.length; hi++) {
      if (isStructural(hkids[hi]) && !subtreeInline(hkids[hi])) {
        collectUnits(hkids[hi], out, []);
      }
    }
    return;
  }
  if (t === "NodeCodeBlock") {
    var code = renderCodeBlock(node);
    if (code !== "") {
      var pendingText = pending.join("").trim();
      if (pendingText !== "") {
        out.push(pendingText);
        pending.length = 0;
      }
      out.push(code);
    }
    return;
  }
  if (isTableRow(t)) {
    var row = renderTableRow(node);
    if (row !== "") {
      var pendingRow = pending.join("").trim();
      if (pendingRow !== "") {
        out.push(pendingRow);
        pending.length = 0;
      }
      out.push(row);
    }
    var kids = nodeChildren(node);
    for (var i = 0; i < kids.length; i++) {
      if (isStructural(kids[i]) && !subtreeInline(kids[i])) {
        collectUnits(kids[i], out, []);
      }
    }
    return;
  }
  var buf = [pending.join("")];
  if (t === "NodeListItem") buf.push(listItemPrefix(node));
  inlineInto(node, buf);
  var kids2 = nodeChildren(node);
  for (var j = 0; j < kids2.length; j++) {
    if (!isStructural(kids2[j])) continue;
    if (subtreeInline(kids2[j])) {
      var piece = [];
      inlineInto(kids2[j], piece);
      buf.push(piece.join(""));
    } else {
      var text = buf.join("").trim();
      if (text !== "") out.push(text);
      buf = [];
      collectUnits(kids2[j], out, []);
    }
  }
  var rest = buf.join("").trim();
  if (rest !== "") out.push(rest);
}

// 标题：级别只认 HeadingLevel（新版思源无 marker 子节点，旧版有也不依赖）。
// marker 节点跳过，残留标记文本兜底剥掉。
function renderHeading(node) {
  var level = parseInt(node.HeadingLevel, 10);
  if (!(level >= 1 && level <= 6)) level = 0;
  var buf = [];
  var kids = nodeChildren(node);
  for (var i = 0; i < kids.length; i++) {
    if (/Marker$/.test(nodeType(kids[i]))) continue;
    inlineInto(kids[i], buf);
  }
  var text = buf.join("").trim().replace(/^[#>\-*]+\s*/, "");
  if (text === "") return "";
  return (level > 0 ? new Array(level + 1).join("#") + " " : "") + text;
}

// pending 在 JS 侧用数组模拟可变字符串（调用方传 []）。
function docMarkdown(doc) {
  var out = [];
  var pending = [];
  var kids = nodeChildren(doc);
  for (var i = 0; i < kids.length; i++) {
    if (!isStructural(kids[i])) {
      inlineInto(kids[i], pending);
      continue;
    }
    collectUnits(kids[i], out, pending);
  }
  var rest = pending.join("").trim();
  if (rest !== "") out.push(rest);
  return out.join("\n\n");
}

function ialTitle(ial) {
  var m = /title="([^"]*)"/.exec(str(ial));
  return m && m[1].trim() ? m[1].trim() : "";
}

function firstHeadingText(nodes) {
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (nodeType(n) === "NodeHeading") {
      var buf = [];
      inlineInto(n, buf);
      var text = buf.join("").trim().replace(/^[#>\-*]+\s*/, "").trim();
      if (text !== "") return text;
    }
    var found = firstHeadingText(nodeChildren(n));
    if (found) return found;
  }
  return "";
}

function docTitle(doc, fallback) {
  var props = nodeProps(doc);
  if (str(props.title).trim() !== "") return str(props.title).trim();
  if (str(doc.content).trim() !== "") return str(doc.content).trim();
  var ial = ialTitle(doc.ial);
  if (ial !== "") return ial;
  var heading = firstHeadingText(nodeChildren(doc));
  if (heading !== "") return heading;
  return fallback;
}

function stemOf(relPath) {
  var base = String(relPath || "").split("/").pop();
  var dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// HTML 实体最小解码（tag 文本是转义后存的；&amp; 最后，避免二次解码）。
function unescapeTagText(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// 文档标签：Properties.tags（逗号分隔）+ 行内 tag 标记，去重保序。
function collectDocTags(doc) {
  var out = [];
  var seen = {};
  function push(raw) {
    var text = unescapeTagText(raw).replace(/^#+|#+$/g, "").trim();
    if (text === "" || seen[text]) return;
    seen[text] = true;
    out.push(text);
  }
  var props = nodeProps(doc);
  var propTags = str(props.tags);
  if (propTags !== "") {
    var parts = propTags.split(",");
    for (var i = 0; i < parts.length; i++) push(parts[i]);
  }
  (function walk(node) {
    var kids = nodeChildren(node);
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (str(c.TextMarkType) === "tag") push(c.TextMarkTextContent);
      walk(c);
    }
  })(doc);
  return out;
}

function topDir(relPath) {
  return String(relPath || "").split("/")[0] || "";
}

function parseDocument(args) {
  var a = asObj(args);
  var relPath = str(a.relPath);
  var content = str(a.content);
  if (relPath === "") throw new Error("缺少 relPath");
  // 笔记本元数据：<box>/.siyuan/conf.json
  if (/(^|\/)\.siyuan\/conf\.json$/.test(relPath) || relPath === ".siyuan/conf.json") {
    var box = topDir(relPath);
    var name = box;
    try {
      var conf = JSON.parse(content);
      if (conf && typeof conf.name === "string" && conf.name.trim() !== "") {
        name = conf.name.trim();
      }
    } catch (e) { /* 坏 conf 视为普通目录名回退，见下自动补 */ }
    return { kind: "notebook", id: box, name: name };
  }
  if (!/\.sy$/i.test(relPath)) return { kind: "skip" };
  var doc;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    throw new Error("解析 .sy 失败: " + (e && e.message ? e.message : e));
  }
  if (!doc || typeof doc !== "object") throw new Error("解析 .sy 失败: 空文档");
  var id = stemOf(relPath);
  return { kind: "doc", id: id, title: docTitle(doc, id), markdown: docMarkdown(doc), tags: collectDocTags(doc) };
}

// 远程源兼容（本地文件源不调这些，保留占位以满足"方法存在"类检查）。
function notSupported(name) {
  throw new Error(name + " 仅远程源可用，本地文件源请走同步管线");
}

var HANDLERS = {
  parseDocument: parseDocument,
  listNotebooks: function () { return notSupported("listNotebooks"), []; },
  listDocuments: function () { return notSupported("listDocuments"), []; },
  getDocument: function () { return notSupported("getDocument"), {}; },
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}
globalThis.call = call;

// Obsidian 知识源 L2 逻辑：本地 vault 解析（宿主遍历授权根目录，逐文件调 parseDocument）。
//
// parseDocument({ relPath, content }) →
//   { kind: "doc", id, title, markdown }  // *.md（id 取相对路径，全局稳定）
//   { kind: "skip" }                      // 其他
//
// 说明：
// - `.obsidian/` 等点开头目录由宿主 walk 层直接跳过，到不了这里；
// - 标题取首个 `# ` 标题，缺省取文件名（去扩展名）；
// - frontmatter 原样保留进 markdown（宿主知识库可渲染）；
// - 图片等附件相对引用 v1 不改写（预览可能不显示，后续版本处理）；
// - 顶层目录自动成笔记本文件夹（宿主侧），无需本插件操心。

function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}

function str(v) {
  return v == null ? "" : String(v);
}

function stemOf(relPath) {
  var base = String(relPath || "").split("/").pop();
  var dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function firstHeading(markdown) {
  var lines = String(markdown || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m && m[1].trim() !== "") return m[1].trim();
  }
  return "";
}

function parseDocument(args) {
  var a = asObj(args);
  var relPath = str(a.relPath);
  var content = str(a.content);
  if (relPath === "") throw new Error("缺少 relPath");
  if (!/\.md$/i.test(relPath)) return { kind: "skip" };
  var title = firstHeading(content);
  if (title === "") title = stemOf(relPath);
  if (title === "") title = relPath;
  return { kind: "doc", id: relPath, title: title, markdown: content };
}

var HANDLERS = {
  parseDocument: parseDocument,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}
globalThis.call = call;

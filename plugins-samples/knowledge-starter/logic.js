// 知识源样板 L2 逻辑：内存演示数据，实现 knowledgeSources 契约。
//   listNotebooks() → [{ id, name, parentId? }]
//   listDocuments({ notebookId?, parentId? }) → [{ id, title, parentId? }]
//   getDocument({ id }) → { title, markdown, updatedAt? }
//   searchNotes({ keyword }) → [{ id, title, snippet? }]
// 落库、命名空间、增量、调度一律由宿主管线负责，插件只返回数据。

function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}

var NOTEBOOKS = [
  { id: "nb-demo", name: "演示笔记本" },
];

var DOCS = [
  {
    id: "doc-hello",
    notebookId: "nb-demo",
    title: "你好，知识源",
    markdown: "# 你好，知识源\n\n这是 `knowledge` kind 插件返回的演示文档。\n",
    updatedAt: 0,
  },
];

function listNotebooks() {
  return NOTEBOOKS.slice();
}

function listDocuments(args) {
  var a = asObj(args);
  return DOCS.filter(function (d) {
    return !a.notebookId || d.notebookId === a.notebookId;
  }).map(function (d) {
    return { id: d.id, title: d.title, parentId: d.notebookId };
  });
}

function getDocument(args) {
  var a = asObj(args);
  var found = null;
  for (var i = 0; i < DOCS.length; i++) {
    if (DOCS[i].id === a.id) found = DOCS[i];
  }
  if (!found) throw new Error("NotFound: " + a.id);
  return { title: found.title, markdown: found.markdown, updatedAt: found.updatedAt };
}

function searchNotes(args) {
  var keyword = String(asObj(args).keyword || "").toLowerCase();
  if (!keyword) return [];
  return DOCS.filter(function (d) {
    return (d.title + "\n" + d.markdown).toLowerCase().indexOf(keyword) >= 0;
  }).map(function (d) {
    return { id: d.id, title: d.title, snippet: d.markdown.slice(0, 80) };
  });
}

var HANDLERS = {
  listNotebooks: listNotebooks,
  listDocuments: listDocuments,
  getDocument: getDocument,
  searchNotes: searchNotes,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}
globalThis.call = call;

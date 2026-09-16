# 知识源样板（`kind: knowledge`）

演示"宿主收管线、插件只做数据源适配"的切分：本包是**只读**数据源，
落库、命名空间隔离、增量状态、调度由宿主负责。

## 契约（L2 `logic.js`）

| 方法 | 入参 | 返回 |
|---|---|---|
| `listNotebooks` | `{}` | `[{ id, name, parentId? }]` |
| `listDocuments` | `{}` | `[{ id, title, parentId?, notebookId?, updatedAt? }]`（裸数组或 `{ documents: [...] }`） |
| `getDocument` | `{ id }` | `{ title, markdown, updatedAt? }`（裸对象或 `{ document: {...} }`） |
| `searchNotes`（可选） | `{ keyword }` | `[{ id, title, snippet? }]` |

未知方法必须抛 `UnknownMethod`（见 `logic.js` 末尾）。

## 清单要点

- `kind: knowledge`，`entry.logic` 必填（方法需要 L2 执行器）。
- `methods[]` 声明全部四个方法（`searchNotes` 可省，对应去掉 `searchMethod`）。
- `contributes.knowledgeSources[]` 每项必含 `id` / `listMethod` / `getMethod`，
  且三者引用的方法必须在 `methods[]` 中声明。

## 校验

```bash
node scripts/validate-plugin.mjs plugins-samples/knowledge-starter
```

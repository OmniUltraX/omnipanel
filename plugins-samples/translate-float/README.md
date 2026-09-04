# 选中翻译样板（第三方插件，无后端代码）

演示第三方插件的完整能力：**选中文字 → 悬浮"译"按钮 → 点击 → L3 overlay → 宿主 AI 翻译（prompt 自控）**。

## 功能

- 语种**自动识别填充**：非中文原文默认译成中文，中文默认译成英文；弹窗里源/目标语言均可切换。
- 原文框**可直接改**，改完点"翻译"（目标语言切换后自动重翻）。
- 三个入口：选中悬浮按钮、右键菜单（同一次登记自动带出）、**首页启动条**（`contributes.ui.home`）。

## 组成

- `plugin.json`：kind=addon，权限 `ui:selection` + `ai:tools`，`entry.ui=ui/main.js`，`overlays.translator=ui/index.html`，`ui.home` 首页入口 + `icon.svg`。
- `ui/main.js`：动态前端入口。activate 登记选中动作（右键菜单 + `float.icon` 悬浮按钮二合一），onClick 带参打开自家 overlay；deactivate 卸除。
- `ui/index.html`：L3 沙箱页。`TRANSLATE_PROMPT` 即翻译 prompt（`{{target}}`/`{{text}}` 占位），经 `host.aiComplete` 调宿主已配模型。

## 用到的宿主能力（均为第三方可用）

| 能力 | 权限 | 说明 |
|---|---|---|
| `host.ui.menu.register` | —（登记即生效，执行时按下表鉴权） | `when.hasSelection` + `float.icon` opt-in 悬浮按钮 |
| `host.ui.overlay.open(id, {text})` | — | 打开自家 L3 overlay 并传参 |
| `host.selectionGet()` | `ui:selection` | 读选区（overlay 内兜底） |
| `host.overlayInitial()` | — | 读带参打开的文本（点击会收起选区，主通道） |
| `host.aiComplete({system, prompt})` | `ai:tools` | 宿主 AI 单次补全，走用户已配模型 |

## 打包安装

```bash
node scripts/validate-plugin.mjs plugins-samples/translate-float
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/translate-float translate-float.omni-plugin
```

设置 → 插件中心 → 安装本地插件 → 权限确认（会列出 `ui:selection, ai:tools`）→ 启用。
随后任意选中文字，鼠标旁浮现"译"按钮，点击即翻译；首页启动条也会出现"选中翻译"入口（无选区时打开可手动粘贴）。未配 AI 模型时会给出可读提示。

## 没加的能力（诚实说明）

- 快捷启动前缀（如 `fy xxx`）：启动器的 query/行/执行是封闭联合类型，连第一方 `es` 都只解析无行，第三方目前接不上。要做需平台新增"动作行"扩展点。
- `ai.tools`（供 AI 反向调用插件）：本样板无 L2 后端方法，声明了也跑不起来，故不凑数。

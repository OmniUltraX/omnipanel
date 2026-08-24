# 权限模型与三级开放梯度

## 权限清单

| 权限 | 控制的能力 |
|---|---|
| `net:connect` | 网络访问（L2 `host.netFetch` / 沙箱 netFetch） |
| `fs:read` | 文件读取（**仅限插件自身安装目录**，越界即拒） |
| `connections:write` | 写入连接（`host.connectionUpsert`；候选 pluginId 必须与当前插件一致） |
| `ssh:exec` | SSH 探测类操作（生产主机走确认） |
| `vault:read` | 读取自己创建的凭据引用 |
| `ai:tools` | 向 OmniMCP 登记 AI 工具 |
| `ui:selection` | 读取宿主选区总线（终端/编辑器/DOM） |
| `ui:sidebar` | 占用侧栏入口 |

强制原则：**缺权即失败，不静默降级**。权限闸在宿主桥内部执行——
无论调用来自前端、WASM 还是 QuickJS，走的都是同一道闸。

## 生产环境闸

`net_fetch` 解析 URL 主机名后，会比对统一连接存储中所有
`env_tag=prod` 连接的目标主机：

- 命中 → 弹出交互式确认框（60 秒无响应自动拒绝）；
- 结果写入审计日志（`plugin.prod-confirm` allowed/blocked）；
- 该行为不可被插件或用户配置绕过。

## 三级梯度

### L1 —— 声明式（零代码，推荐起步）

表单、workbench 插槽、主题 token、菜单、AI 工具元数据、Overlay 声明。
宿主解释执行，无任何插件代码运行。样板：`plugins-samples/l1-starter`。

### L2 —— 逻辑包（wasm / js）

`entry.logic` 指向 `logic.wasm` 或 `logic.js`。合同：

```js
// logic.js（QuickJS）
globalThis.call = function (method, argsJson) {
  // host.netFetch({url, headers}) / host.fsRead(path)
  // host.connectionUpsert(candidateJson) / host.invoke(method, argsJson)
  return JSON.stringify({ /* 结果 */ });
};
```

- 资源护栏：内存 64MB、栈 1MB、单次调用默认 10s 中断（QuickJS）；
- 宿主函数按 `methods[]` 白名单 + 权限注解逐次校验；
- 样板：`plugins/importer-warpgate/logic.js`。

### L3 —— 沙箱 UI

`contributes.overlays[].entry` 指向 HTML。运行环境：

- iframe `sandbox="allow-scripts"`（不透明 origin，无同源权限）；
- CSP `default-src 'none'`（脚本/样式仅限内联）；
- 与宿主通信仅限 postMessage 白名单：`selection.get` / `invoke` / `netFetch` / `overlay.hide`，
  每条消息经宿主权限闸；
- 样板：`plugins-samples/l3-translator`。

## 错误码速查

| 场景 | 表现 |
|---|---|
| 缺权限 | 调用失败，错误含 `缺少权限 <perm>` |
| 未声明 method | `UnknownMethod` |
| prod 未确认 / 用户拒绝 | 「已拦截对生产环境目标的访问」+ audit blocked |
| fsRead 越界 | 「fsRead 仅允许访问插件自身目录」+ audit blocked |
| minHostApi 过高 | 安装时拒绝：「minHostApi N 高于宿主当前版本 1」 |

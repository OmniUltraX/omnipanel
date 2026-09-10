# @omnipanel/plugin-sdk

OmniPanel 插件 SDK：清单 Zod schema、Host API 类型与 L1/L2/L3 合同。

- 宿主 API 版本：`HOST_API_VERSION = 1`（见 `crates/omnipanel-plugin/src/manifest.rs`）
- 完整开发指南：仓库 `docs/plugins/README.md`
- 发版步骤：`docs/plugins/sdk-release.md`

## 安装

```bash
npm install @omnipanel/plugin-sdk
```

## 三级梯度

| 级别 | 你要写什么 | 需要的权限 |
|---|---|---|
| L1 | 只有 `plugin.json`（表单 / 主题 token / 菜单 / AI 工具元数据） | 无 |
| L2 | `entry.logic` 指向 `logic.js`（QuickJS）或 `logic.wasm` | 按 `methods[].permissions` |
| L3 | `overlays[].entry` 指向 HTML，进沙箱 iframe | 按桥消息逐条过闸 |

七种 `kind`：`engine` / `panel` / `cloud` / `module` / `importer` / `theme` / `addon`。

## 校验清单（构建期 / CI）

```ts
import { parsePluginManifest } from "@omnipanel/plugin-sdk";

const manifest = parsePluginManifest(JSON.parse(rawJson));
// 非法清单抛 ZodError，可直接接进 CI
```

## L2 逻辑包（QuickJS）

客体合同：脚本内定义 `globalThis.call(method, argsJson) -> JSON 字符串`，宿主注入全局 `host`。

```js
globalThis.call = function (method, argsJson) {
  if (method !== "fetchTargets") throw new Error("未知方法: " + method);
  var body = host.netFetch(JSON.stringify({ url: "https://example.com/api" }));
  return JSON.stringify({ items: JSON.parse(body) });
};
```

`host.*`：`ping` / `hmac` / `hash` / `sign` / `encode` / `stateGet` / `stateSet` / `netFetch` / `fsRead` / `vaultGet|Has|Put|Delete` / `connectionUpsert` / `invoke`。缺权调用一律失败。

## 动态前端（第三方 `entry.ui`）

```js
const { definePlugin } = require("@omnipanel/plugin-sdk");

module.exports = definePlugin({
  activate(ctx) {
    ctx.launcher.registerPrefix("es");
    return () => ctx.launcher.unregisterPrefix("es"); // 或提供 deactivate
  },
});
```

## 权限

`vault:read` / `connections:write` / `net:connect` / `ssh:exec` / `ui:selection` / `ui:sidebar` / `ai:tools` / `fs:read`。

清单未声明即无权限；`env_tag=prod` 目标的网络访问会强制二次确认，不可绕过。

## License

MIT

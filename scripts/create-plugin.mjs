#!/usr/bin/env node
/**
 * create-plugin — 第三方 L1 插件脚手架。
 *
 * 用法：node scripts/create-plugin.mjs <plugin-name> [engine|theme]
 *
 * 产出 plugins-custom/<plugin-name>/：
 *   - plugin.json   L1 声明式清单（engine 表单 或 theme token）
 *   - README.md     打包与安装说明
 *
 * 打包：cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/<name> <name>.omni-plugin
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , rawName, kindArg] = process.argv;
const name = (rawName ?? "").trim();
const kind = (kindArg ?? "engine").trim().toLowerCase();

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("用法: node scripts/create-plugin.mjs <plugin-name> [engine|theme]");
  console.error("  plugin-name: 小写字母/数字/连字符，字母开头");
  process.exit(2);
}
if (!["engine", "theme"].includes(kind)) {
  console.error(`不支持的 L1 kind: ${kind}（当前支持 engine | theme）`);
  process.exit(2);
}

const dir = path.join(root, "plugins-custom", name);
if (existsSync(dir)) {
  console.error(`已存在: ${dir}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const id = `omni.${kind}.${name}`;
let manifest;
if (kind === "engine") {
  manifest = {
    id,
    version: "0.1.0",
    kind: "engine",
    permissions: ["net:connect"],
    contributes: {
      ui: {
        connectionForm: {
          engineKey: name,
          aliases: [name],
          defaultPort: 8080,
          icon: name.slice(0, 2).toUpperCase(),
          fields: [
            { key: "host", type: "text" },
            { key: "port", type: "number" },
            { key: "password", type: "password" },
          ],
        },
        workbench: { tree: "none", editor: "none", preview: "none", connectionInfo: "sql" },
      },
    },
  };
} else {
  manifest = {
    id,
    version: "0.1.0",
    kind: "theme",
    permissions: [],
    contributes: {
      themes: {
        tokens: {
          id,
          js: false,
        },
      },
    },
  };
}

writeFileSync(
  path.join(dir, "plugin.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

writeFileSync(
  path.join(dir, "README.md"),
  `# ${name} — OmniPanel L1 插件（${kind}）

由 \`scripts/create-plugin.mjs\` 生成的声明式模板，无任何可执行代码。

## 打包

\`\`\`bash
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/${name} ${name}.omni-plugin
\`\`\`

## 安装

设置 → 插件 → 「安装本地插件」选择 \`${name}.omni-plugin\`。

- release 构建：仅接受官方签名（联系维护者加入发布流程）。
- dev 构建：接受本命令的开发签名 / 未签名包。

## 下一步

- engine：调整 \`connectionForm.fields\` 与默认端口；需要查询逻辑时进入 L2（WASM）。
- theme：补全 \`tokens.json\` 公开 token 与终端色板。
`,
);

console.log(`已生成 ${path.relative(root, dir)}`);
console.log(`打包: cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/${name} ${name}.omni-plugin`);

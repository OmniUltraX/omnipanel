# GitHub Copilot Instructions

This project uses CLAUDE.md as the primary guidance file. See [CLAUDE.md](../CLAUDE.md) for full project context, architecture, and conventions.

## Mandatory Type Check (强校验)

**所有前端代码变更完成后，必须运行 `tsc -b` 通过后才能视为完成。** 这是 CI 流水线（`tauri-apps/tauri-action` → `build:ci` → `tsc -b && vite build`）的强校验门禁，本地不通过则 CI 必挂。

```bash
cd frontend && npx tsc -b
```

- 零 error 才算通过；warning 可接受但建议修复。
- 新增/删除 import 时同步检查未使用变量（TS6133）。
- 类型变更时检查跨文件兼容性（TS2322/TS2345 等）。
- 测试文件的类型必须与被测代码的签名严格匹配，不要用 `typeof` 推断具体字面量类型代替 `Record<string, ...>` 等宽泛类型。

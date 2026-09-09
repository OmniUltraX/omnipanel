## Why

插件工作台已能建工程、改文件、校验、打包，但 AI 仍是一条 oneshot 输入框，和宿主 AI Dock（会话 / 工具 / 当前现场）完全断开。打开侧栏也看不见插件工程。

## 目标

把现有 AI Dock 接到工作台：注入工程现场、进 tab 按偏好打开侧栏、入口走 `sendToAiDock`，Agent 用 `omni_studio_*` 读写校验。不新做一套聊天 UI。

## 非目标

不做 LSP / Git / 通用 IDE；不把 plugins 塞进 `ModuleKey`；发行版无源码树时工具仍受 `plugins-custom` 禁锢（失败即可）。

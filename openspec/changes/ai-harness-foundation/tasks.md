## 1. OpenSpec 与编排地图

- [x] 1.1 撰写 proposal / design / specs
- [x] 1.2 落地 `frontend/src/lib/ai/harness/writeEntries.ts` 写入口白名单注释与导出
- [x] 1.3 落地 harness `README.md` 指向 design 编排图

## 2. Harness inventory

- [x] 2.1 实现 `buildHarnessInventory`（plans/clusters/agent/toolsMode）
- [x] 2.2 设置 Agent 页增加 Harness 只读面板
- [x] 2.3 单测：有 plan+cluster / 无编排 两种快照

## 3. Experience digest 与反馈

- [x] 3.1 实现 `buildExperienceDigest`（planSummary、clusterSummaries、trace 错误线索）
- [x] 3.2 Trace 面板展示 digest 摘要
- [x] 3.3 SkillEvolution / 提取入口可附带 digest
- [x] 3.4 单测 digest 字段

## 4. Prompt 与 Loop / Context

- [x] 4.1 补齐 database/docker/files 默认 agent md + `agent_prompt` 种子
- [x] 4.2 Loop 无 pilot 时实验语义文案加强
- [x] 4.3 ContextBridge 契约注释（terminal/database 代表）

## 5. 对齐与验收

- [x] 5.1 回归：inventory/digest 单测
- [x] 5.2 登记后续 change 名 `ai-first-surfaces`（本文件脚注 + harness README）
- [x] 5.3 验收问句清单写入 harness README

## 后续（不在本 change 实现）

- `ai-first-surfaces`：Dashboard AI 输入框、建议/提醒、模块面板「问 AI」（复用提交管线与 plan/cluster）。

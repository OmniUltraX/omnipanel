# DB Panel / Grid / Schema / i18n 激进结构优化

状态：已落地（激进版首轮）  
日期：2026-09-04  
范围：DatabasePanel 拆分、叶子窄订阅、TableDataGrid/SchemaBrowser 拆文件、i18n 模块懒加载  
前置：Shell+DB 收敛版（ModuleRuntimeOutlet、dockTabsStore）

## 目标

1. DatabasePanel 变壳（&lt;~1500 行）
2. 叶子只订本 tab 切片
3. TableDataGrid / SchemaBrowser 物理拆多文件
4. i18n 按顶层 key 分 chunk，启动只带 shell 必需包

## 阶段

| 阶段 | 内容 |
|------|------|
| T0 | i18n locales 拆分 + ensureChunks |
| T1 | Panel → hooks / DockHost / DialogsHost |
| T2 | tab 级窄订阅 hooks |
| T3 | TableDataGrid hooks/子文件 |
| T4 | SchemaBrowser hooks/树视图 |

## 非目标

Toolbox 整拆；dockview 重写；不擅自 git commit。

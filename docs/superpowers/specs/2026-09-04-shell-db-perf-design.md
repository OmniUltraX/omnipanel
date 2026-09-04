# Shell + DB 性能结构优化（收敛版）

状态：已落地（收敛版）  
日期：2026-09-04  
范围：Module Runtime keepAlive、AppShell 订阅隔离、Database Session/Tab 编排收敛  
前置：Module Runtime P0–P4

## 1. 目标

1. keepAlive 编排进入 Module Runtime；`AppShell` 不再手算 mounted。
2. Shell 订阅隔离：导航/抽屉无关时，叠层模块树不因 App 重渲失效。
3. DB：`workspaceTabs` / 激活生命周期由 Session 门面 + store 拥有；`DatabasePanel` 变薄。
4. **不拆** `TableDataGrid` / `Toolbox` / `SchemaBrowser`。

## 2. 架构

```
AppShell（boot / chrome / 窄路由副作用）
  └─ ModuleRuntimeOutlet（memo，无 props）
        · pathname → touch keepAlive
        · pin ← workspace bottom dock
        · ModuleHost + shell Routes
DatabaseSessionService
  · Tab list / activate / dispose 真相源（store）
DatabasePanel
  · 连接/侧栏/对话框 + renderDockPanel 分发
```

## 3. 阶段

| 阶段 | 内容 |
|------|------|
| S1 | KeepAlive → `ModuleRuntimeOutlet` |
| S2 | `routePanels` / `topbarActions` 稳定引用 |
| S3 | DB Tab 状态进 Session/store |
| S4 | Panel 编排函数外移，瘦身 |

## 4. 验收

- `npx tsc -b` 零 error
- LRU：当前 + 最近 1 + pin 行为不变
- DB：切模块 Tab/脏标连续；踢出不 dispose Tab

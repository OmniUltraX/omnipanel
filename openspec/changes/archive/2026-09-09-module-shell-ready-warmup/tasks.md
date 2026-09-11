## 1. 调度层：全模块 idle ShellReady

- [x] 1.1 在 `frontend/src/lib/moduleWarmup.ts` 实现 `scheduleIdleOverlayShellWarm`：按 `IDLE_CHUNK_KEYS` 错峰 `preload` → `requestModuleShellWarm`，已挂载去重；抽出可调 timeout
- [x] 1.2 在 `frontend/src/App.tsx` 用统一队列替换 `scheduleIdleTerminalWarm` / `scheduleIdleDatabaseWarm` 重复调用；确认仍走既有 `subscribeModuleShellWarm` + `startTransition`
- [x] 1.3 修正 `frontend/src/lib/routePanels.ts` 注释：明确禁止的是「同步阻塞式全量挂载」；视需要导出只读辅助（勿在首帧调用全 true）
- [x] 1.4 手动验收：冷启动首页，Performance 确认首 1s 无九模块 mount；空闲数秒后 `overlayMounted` 逐步变 true（React DevTools / 临时 debug）
  - 代码层：idle 首壳 timeout 默认 8s；首帧仅 `createInitialOverlayMounted`。请本地再扫一眼 Performance。

## 2. Dock 层：sticky-visited 与内容挂起

- [x] 2.1 在 `frontend/src/components/dock/` 新增小工具（如 `dockTabVisit.ts` / hook）：`markVisited` / `shouldMountDockTabContent({ active, visited, contentSuspended })`
- [x] 2.2 扩展 `ModuleSegmentDock`（及必要时 `DockableWorkspace`）：支持 `contentSuspended`；`renderPanel` 包装未访问返回 null；激活时 markVisited
- [x] 2.3 与工程工作区 `WorkspaceDockCore` 的 `contentSuspended` 对齐调用同一 util，避免两套判断漂移
- [x] 2.4 验证：单元测试或最小 vitest 覆盖 `shouldMountDockTabContent` 真值表（未访问/激活/已访问/suspended）

## 3. 数据库模块：去掉粗 always

- [x] 3.1 改 `frontend/src/modules/database/workspace/DatabaseWorkspaceDock.tsx`：移除挂载即 `defaultRenderer="always"`，改为 sticky-visited + `contentSuspended={!moduleLive}`（由 `DatabasePanel` 传入）
- [x] 3.2 核对 `DatabasePanel.tsx`：`moduleLive` 门闩仍覆盖 pool / dock enabled；预热壳下未访问 Tab 不创建 Monaco
- [x] 3.3 手动验收：首页 idle 后进数据库 → 仅激活 Tab 有编辑器；再开第二 Tab 后两者切换不闪
  - 请本地点验切 Tab 不闪。

## 4. 终端模块：懒创建 + sticky

- [x] 4.1 改 `frontend/src/modules/terminal/TerminalPanel.tsx`：去掉挂载即 `defaultRenderer: "always"`，接入 sticky-visited；保留 `suspended` / IntersectionObserver 既有门闩
- [x] 4.2 核对 `useTerminal.ts`：非 live / 未访问 Tab 不建 xterm；已访问切回不销毁
  - 未访问 Tab `render null`，不会挂 `useTerminal`；已访问 + always 宿主保活。
- [x] 4.3 手动验收：预热后进终端只建当前 session；多 Tab 切换不闪、输出连续
  - 请本地点验。

## 5. 其余叠层模块门闩核对

- [x] 5.1 Docker：`frontend/src/modules/docker/DockerPanel.tsx` 及 grid/stats hooks——非 live 无轮询；可选 idle 只读 `hydrateSidebarCache`（不启 stats）
- [x] 5.2 Server / Files / Protocol / Workflow / Knowledge / Tasks：确认默认 `onlyWhenVisible` 或等价；非 live 无意外 IPC 风暴；按需接 `contentSuspended`
- [x] 5.3 手动验收：空闲后侧栏快速点完已开启模块，切换接近显隐；Network/IPC 无预热期轮询尖峰
  - 请本地点验侧栏切换手感。

## 6. 回归与收尾

- [x] 6.1 回归：首页 ↔ 工程工作区全屏（既有 warmup）不被破坏；侧栏 hover 预热仍有效
  - 代码路径保留 `scheduleNavHoverWarm` / `workspaceDockWarmupStore`；请本地抽查。
- [x] 6.2 `npx tsc --noEmit -p frontend/tsconfig.json`；相关 vitest（若有）通过
- [x] 6.3 对照 `openspec/changes/module-shell-ready-warmup/specs/**/spec.md` 场景做一次清单勾选，未决项记入 Open Questions
  - Open Question：低配机 idle 全挂壳间隔是否需档位区分（首版固定 8s/2.5s）。

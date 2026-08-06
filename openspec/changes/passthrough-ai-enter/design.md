## Context

对齐阿里云 WebSSH 的本质不是「内联聊天」，而是：

```
AI 文本 → shell 工具提案（审核）→ 真实 PTY 执行 → 采集输出 → AI 文本 → …
```

直通负责**原生键入**；智能 Enter 只是**入环**；产品灵魂是与 session PTY 绑定的 **shell-tool Agent 循环**。

现状积木：

- 直通 `interactive`：键 → PTY
- `shouldRouteInputToAi`、OSC 133、`terminalApprovalPolicy`、`inlineToolBridge`（已有 tool-call 审批/执行碎片）
- 命令栏 inline AI：偏单次/块对话，**不能直接当成完整环**

前后端边界：

| 层 | 职责 |
|----|------|
| `crates` / `commands` | MVP **尽量无新 IPC**；PTY I/O、既有 AI chat/tool 回传沿用。若环需要独立 turn API，再加 specta 命令并 `gen:bindings` |
| `frontend/modules/terminal/passthroughAi/` | 行缓冲、Enter 闸门、清行、入环 |
| `frontend/modules/terminal/shellAgent/`（新） | Agent 环状态机：turn、工具提案、审核、执行、observation、续轮、新会话 |
| `inlineToolBridge` / `executeTerminalCommand` / `terminalApprovalPolicy` | 审核与写 PTY、采输出的执行层（被环调用，而不是反过来「调一次 prompt 结束」） |
| `lib/ai` | 模型流式与 tool 协议；环决定何时发 user/tool result，而不是只 `submitAiPrompt` 一次 |
| settings / i18n | 开关、文案 |
| UI | 终端流内：AI 文本块 + 命令审核卡；样式跟 tokens / `design/terminal.html`；不新造侧栏会话为主路径 |

联动：`/terminal`、SSH 壳、共享 `useTerminal` 的直通嵌入页。

## Goals / Non-Goals

**Goals:**

- 完整 Agent 环（多轮自动续跑，以 shell 执行为主工具）。
- 直通 NL Enter 入环；门闩保护 vim/Ctrl+R。
- 命令级「已同意」；执行在真 PTY；输出回灌。
- 「开启新会话」重置 Agent 上下文，PTY 可保留。

**Non-Goals:**

- 单次内联问答冒充完成。
- 首期多工具（web search 等）。
- 重写整屏为 React 时间线（可先 overlay/夹层块，视觉二期逼近）。
- 改命令栏默认产品形态。

## Decisions

### 1. 架构分层：入口 ≠ 环；数据链路 ≠ 表现层

```
[直通按键]
   │
   ├─ 普通键 / 门闩关闭 ──► PTY
   └─ Enter + NL ──► 清行(等回显静默) ──► 画蓝字行+占位 ──► ShellAgent.start|continue(userText)
                                                             │
                                                             ▼
                              数据链路（复用现有，不重造）：
                              submitInlineNaturalLanguage → blocksStore aiThread
                              → 后端 conversation 流式 → tool_call(omni_ssh_exec)
                              → inlineToolBridge 审批 → executeAiTerminalCommand(真 PTY)
                              → aiChatToolResult IPC → 后端自动续轮（多轮机制已存在）
                                                             │
                              表现层（本次重写）：
                              shellAgentStore phase ──► decoration 卡片几何与内容
```

- **选**：显式 `ShellAgent` 状态机驱动**表现层与几何**；多轮续跑由后端 conversation 驱动（`aiChatToolResult` 后自动续 turn），前端不重造模型栈。
- **选**：数据源复用 blocksStore 的 aiThread（流式文本/工具提案的可靠来源）；渲染宿主从「底部浮层」换成「流内 decoration」。
- **弃**：上一版 loop.ts 对 warpInlineAi 的套壳式封装——phase 只记录不驱动。

### 2. 主工具：`run_shell`（本会话）

- 参数：`command: string`（及可选 timeout）。
- 副作用：仅写**当前** terminal session PTY。
- 返回：`{ stdout, stderr?, exitCode, truncated? }`（OSC 133 D 优先；否则超时/启发式结束）。
- 审批：每条命令经 `terminalApprovalPolicy`；UI 显示「已同意」态（与阿里一致的可感知审核）。
- **弃**：让模型直接吐「请用户复制命令」而无 tool（环会断）。

### 3. 执行与观察

- 同意后：注入 `command + \r`（或既有 execute 路径），标记本命令为 agent 发起。
- 用 OSC 133 C/D（有则）界定输出窗口；采集文本回灌为 tool result。
- 失败（非零退出 / not found）**不**结束环：结果回灌后模型继续提案（截图中 sqlite3 场景）。
- 灯泡：可选 UI，表示「本段输出已进入 observation」；非必须协议。

### 4. 与 `inlineToolBridge` 关系

- **选**：环调用/收敛现有 bridge 的审批+执行，避免两套写 PTY。
- **弃**：命令栏 inline 聊天 UI 直接当环宿主（心智与直通冲突）；可共享协议与策略代码。

### 5. Enter 闸门（入口）

- 同前：主 prompt + 非 alt-screen + 非 reverse-i-search；`shouldRouteInputToAi`；Ctrl+U 清行；fail-open。
- **清行时序纪律**：发 Ctrl+U（PowerShell 发 Esc）后，**等回显静默**（OSC 133;A 优先；否则输出空闲 ~60ms）再画蓝字行；禁止上一版的裸 `setTimeout(80)` 竞态。
- Agent **忙**（等待模型或等待审核）时：用户 Enter 默认不新开环；Esc 取消/新会话另议。

### 6. UI 宿主（流内 decoration 混排 —— 方案 C）

**选**：xterm `registerDecoration` + React portal，卡片流内锚定；底部 dock 仅作降级。

几何纪律（上一版失败根因的修正）：

1. **伪造内容只有两类，且全部可见**：蓝字问题行（1 行）+ 占位空行（N 行，必须被 decoration 卡片盖住）。绝不允许「写了占位行却用底部浮层」——裸空行是上一版"乱七八糟"的直接来源。
2. **占位行归卡片所有**：清行 → 画蓝字问题行 → 写 `\r\n`×N 占位 → marker 注册在占位区首行 → decoration `height=N` 盖住。光标天然落在占位区下方，approve 后命令回显/输出/新 prompt 依次下流，无需任何几何变更。
3. **approve 不改几何**：卡片高度不变，内容切换为紧凑「✓ 已同意 + cmd」态；避免 dispose/重建带来的闪烁与失同步。
4. **续轮重锚**：命令输出 + 新 prompt 就位后，在当前光标处重新占位 + decoration（用户正在 prompt 打字则 dock）。
5. **续轮与用户输入冲突**：observing/streaming 到来时若行缓冲非空（用户正在 prompt 打字），同样走 dock，不写占位行。
6. **降级**：`registerDecoration` 返回 undefined / onRender 未触发 / marker 被 dispose（清屏、reset）→ 底部 dock 兜底，功能不受影响。
7. **resize**：marker 随 reflow 移动，decoration 按新 cols 重注册宽度。

- **弃**：无占位的浮层 decoration（盖输出）；底部浮板作主路径（不随滚动、盖内容）。
- **弃**：MVP 重写整屏为 React 时间线；命令栏 Block 形态不变。

### 7. 开关

- `terminal.passthroughAiEnter`：是否 NL 入环。
- `terminal.shellAgentAutocontinue`：执行后是否自动把 observation 送回模型（默认 true；关闭则停在「已执行」，需用户再输入才续）。

### 8. 安全

- 每条 `run_shell` 独立过审批；prod 强确认。
- 环不得提供「跳过所有审批」后门。
- 拒绝命令：tool result = rejected，模型可改方案或停止。

## Risks / Trade-offs

- **[Risk] 占位行与 shell echo 错位（续轮时用户正在打字）** → Mitigation：行缓冲非空时本轮卡片降级 dock（决策 6.5）。
- **[Risk] decoration 挂不上 / marker 被 dispose（清屏、reset、reflow 极端情况）** → Mitigation：dock 兜底；`onRender` 超时未触发即降级。
- **[Risk] 清行回显与画蓝字行竞态** → Mitigation：等回显静默后再画（决策 5）；宁可晚 60ms 不可画早。
- **[Risk] 采输出边界不准（无 OSC 133）** → Mitigation：超时 + 空闲启发式；文档要求 shell integration 体验更好。
- **[Risk] 无限续轮烧钱** → Mitigation：maxTurns、用户取消、新会话；可选自动续轮开关。
- **[Risk] 行缓冲误判** → Mitigation：fail-open 放行 Enter。

## Migration Plan

1. 重写几何层（占位 + marker + decoration 生命周期）与入口时序。
2. 重写 UI 宿主为 decoration portal + dock 降级；loop.ts 收敛为 phase 驱动几何。
3. 端到端验证「缺命令 → 安装」两轮续环（本地 + SSH）。
4. 设置默认开；可关回滚到纯直通。
5. 无强制数据迁移。

## Open Questions

1. 环是否复用侧栏 conversation_id，还是 terminal-session 专用 agent thread？（建议：每 PTY session 一个 agent thread，可「开新会话」重置。）
2. 低风险命令（如 `date`）能否策略性自动「已同意」？（建议：跟现有 `view`/`loose`/`strict` 模式对齐，不单开逻辑。）
3. 用户手动敲的命令失败，是否也自动入环观察？（阿里有灯泡；建议二期，MVP 仅 agent 发起的执行自动续轮。）

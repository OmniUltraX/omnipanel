import { Fragment, useEffect, useCallback, useState, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { createTerminalTabId, useTerminalStore, type PaneLayout, type TerminalPane, type TerminalTab } from "../../stores/terminalStore";
import { useTerminal } from "../../hooks/useTerminal";
import { getResourceById, getSshHosts, type WorkspaceResource } from "../../lib/resourceRegistry";
import { openSshTerminalSession } from "../../lib/terminalSession";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useAiStore } from "../../stores/aiStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

let tabCounter = 0;

const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function tabLabel(tab: TerminalTab) {
  const pane = tab.panes.find((item) => item.id === tab.activePaneId) ?? tab.panes[0];
  if (pane?.type === "remote") {
    return getResourceById(pane.resourceId)?.name ?? tab.title;
  }
  return tab.title;
}

type SessionBlueprint = {
  summary: string;
  facts: string[];
  goals: string[];
  commandPack: string[];
  relatedModules: Array<{ label: string; path: string; resourceId?: string }>;
  startup: string[];
};

const SESSION_BLUEPRINTS: Record<string, SessionBlueprint> = {
  "local-terminal": {
    summary: "本地构建与脚本工作台，适合开发、验证与命令编排。",
    facts: [],
    goals: ["运行本地构建或脚本", "接收 SSH / Docker 模块推送的指令", "与工作流执行记录联动"],
    commandPack: ["npm run dev", "npm run build", "git status"],
    relatedModules: [],
    startup: ["本地会话已就绪，可直接执行开发命令。"],
  },
  "prod-web-01": {
    summary: "生产入口节点，聚焦容器巡检、日志排障与发布验证。",
    facts: ["4 个核心容器", "2 条 SSH Tunnel", "nginx + app + redis"],
    goals: ["先看容器与健康检查", "确认 nginx 与 upstream 状态", "必要时切换到部署工作流"],
    commandPack: [
      "docker ps --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\"",
      "docker logs nginx-proxy --tail 50",
      "curl -s localhost:8080/health | jq .",
      "systemctl status nginx --no-pager",
    ],
    relatedModules: [
      { label: "SSH 总览", path: "/ssh", resourceId: "prod-web-01" },
      { label: "Docker 容器", path: "/docker", resourceId: "docker-prod-web" },
      { label: "Workflow 发布", path: "/workflow" },
    ],
    startup: ["推荐先执行 docker ps 与健康检查，再决定进入日志或发布流程。"],
  },
  "prod-web-02": {
    summary: "生产金丝雀节点，适合灰度验证、回滚检查与证书续期。",
    facts: ["Canary 节点", "1 条活动转发", "流量较低"],
    goals: ["验证灰度版本状态", "检查 nginx reload 结果", "必要时回到主站对比"],
    commandPack: [
      "docker compose ps",
      "journalctl -u nginx -n 50 --no-pager",
      "curl -I https://canary.example.com",
      "systemctl reload nginx",
    ],
    relatedModules: [
      { label: "SSH 总览", path: "/ssh", resourceId: "prod-web-02" },
      { label: "Docker 容器", path: "/docker", resourceId: "docker-prod-web" },
      { label: "Workflow 发布", path: "/workflow" },
    ],
    startup: ["这类会话更适合做发布后验证与快速回滚演练。"],
  },
  "staging-bastion": {
    summary: "预发堡垒机，适合接力排障、审计检查与多机中转。",
    facts: ["Bastion / 审计", "预发环境", "适合作为中转入口"],
    goals: ["确认中转路径可用", "检查预发 API 与 worker 状态", "整理审计上下文"],
    commandPack: [
      "ssh deploy@staging-api.internal",
      "journalctl -u ml-worker -n 50 --no-pager",
      "docker ps",
      "htop",
    ],
    relatedModules: [
      { label: "SSH 总览", path: "/ssh", resourceId: "staging-bastion" },
      { label: "服务器监控", path: "/server", resourceId: "staging-api" },
      { label: "Workflow 巡检", path: "/workflow" },
    ],
    startup: ["可以把它当作 SSH 入口编排中心，而不只是单条连接。"],
  },
  default: {
    summary: "会话已纳入统一终端工作区，可接收来自 SSH、Docker、Server 的上下文。",
    facts: [],
    goals: ["先确认目标资源状态", "执行最小必要命令", "将下一步动作推入工作流"],
    commandPack: ["pwd", "ls -la", "git status"],
    relatedModules: [],
    startup: ["当前会话可按资源类型切换不同命令包与模块入口。"],
  },
};

function getBlueprint(resource: WorkspaceResource | null, tab: TerminalPane | null) {
  const base = SESSION_BLUEPRINTS[resource?.id ?? "default"] ?? SESSION_BLUEPRINTS.default;
  return {
    ...base,
    commandPack: Array.from(new Set([...(tab?.commandPack ?? []), ...base.commandPack])),
    purpose: tab?.purpose ?? (tab?.type === "remote" ? "SSH Workbench" : "Local Workspace"),
  };
}

function getPromptPrefix(resource: WorkspaceResource | null) {
  const identity = resource?.subtitle?.split("@")[0] ?? "root";
  const host = resource?.name ?? "omnipanel";
  return `${identity}@${host}:~$`;
}

function getMockCommandOutput(command: string, resourceName: string) {
  const normalized = command.trim().toLowerCase();

  if (normalized.startsWith("ssh ")) {
    return [
      `Pseudo terminal established for ${resourceName}.`,
      "Host added to known hosts.",
      "Use command packs from the right pane to continue.",
    ];
  }

  if (normalized.includes("docker ps")) {
    return [
      "NAMES            STATUS       PORTS",
      "nginx-proxy      Up 3 days    0.0.0.0:443->443/tcp",
      "app-backend      Up 3 days    0.0.0.0:8080->8080/tcp",
      "redis-cache      Up 3 days    6379/tcp",
      "postgres-main    Up 3 days    5432/tcp",
    ];
  }

  if (normalized.includes("health")) {
    return [
      "{",
      '  "status": "healthy",',
      '  "uptime": "72h14m",',
      '  "connections": 847,',
      '  "memory_mb": 1024,',
      '  "cpu_percent": 23.4',
      "}",
    ];
  }

  if (normalized.includes("journalctl") || normalized.includes("docker logs")) {
    return [
      "2026-05-26 09:12:01 [warn] upstream connection timeout",
      "2026-05-26 09:13:45 [info] 200 GET /api/users 12ms",
      "2026-05-26 09:13:46 [info] 200 GET /api/users 8ms",
      "2026-05-26 09:14:02 [warn] rate limit triggered for 45.33.32.x",
    ];
  }

  if (normalized.includes("npm run build")) {
    return [
      "> app@2.1.0 build",
      "> vite build",
      "",
      "vite v8.0.14 building for production...",
      "✓ modules transformed.",
      "dist/index.html                  0.46 kB │ gzip: 0.30 kB",
      "dist/assets/index.css            48.12 kB │ gzip: 8.94 kB",
      "dist/assets/index.js            312.47 kB │ gzip: 94.23 kB",
      "✓ built in 3.82s",
    ];
  }

  if (normalized.includes("systemctl status nginx")) {
    return [
      "● nginx.service - A high performance web server",
      "   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)",
      "   Active: active (running) since Mon 2026-05-26 06:15:23 UTC; 3 days ago",
      "   Docs: man:nginx(8)",
    ];
  }

  return [`Command executed in ${resourceName} preview mode.`];
}

function seedMockTerminal(term: Terminal, resource: WorkspaceResource | null, startup: string[]) {
  const prompt = getPromptPrefix(resource);
  [
    `\x1b[90mWorkspace attached: ${resource?.name ?? "omnipanel"}\x1b[0m`,
    ...startup.map((line) => `\x1b[36m${line}\x1b[0m`),
    `\x1b[32m${prompt}\x1b[0m docker ps --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\"`,
    "NAMES            STATUS       PORTS",
    "nginx-proxy      Up 3 days    0.0.0.0:443->443/tcp",
    "app-backend      Up 3 days    0.0.0.0:8080->8080/tcp",
    "redis-cache      Up 3 days    6379/tcp",
    "postgres-main    Up 3 days    5432/tcp",
    "",
    `\x1b[32m${prompt}\x1b[0m curl -s localhost:8080/health | jq .`,
    "{",
    '  "status": "healthy",',
    '  "uptime": "72h14m",',
    '  "connections": 847,',
    '  "memory_mb": 1024,',
    '  "cpu_percent": 23.4',
    "}",
  ].forEach((line) => term.writeln(line));
}

function TerminalView({
  sessionId,
  resource,
  startup,
  onSenderChange,
}: {
  sessionId: string;
  resource: WorkspaceResource | null;
  startup: string[];
  onSenderChange: (sessionId: string, sender: ((cmd: string) => void) | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<((cmd: string) => void) | null>(null);
  const setStatus = useTerminalStore((state) => state.setStatus);

  useTerminal(sessionId, containerRef, undefined, undefined, undefined, !isTauriRuntime, {
    inputMode: "external",
    sendRef,
    active: true,
  });

  useEffect(() => {
    if (!isTauriRuntime) return;
    onSenderChange(sessionId, sendRef.current);
    return () => {
      onSenderChange(sessionId, null);
    };
  }, [onSenderChange, sessionId]);

  useEffect(() => {
    if (isTauriRuntime) return;
    const container = containerRef.current;
    if (!container) return;

    const prompt = getPromptPrefix(resource);
    const resourceName = resource?.name ?? "omnipanel";
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      theme: {
        background: "#1a1717",
        foreground: "#fdfcfc",
        cursor: "#fdfcfc",
        selectionBackground: "#007aff30",
      },
      scrollback: 5000,
      allowTransparency: false,
    });

    term.open(container);
    term.attachCustomKeyEventHandler(() => false);
    termRef.current = term;
    seedMockTerminal(term, resource, startup);
    setStatus(sessionId, "connected");
    onSenderChange(sessionId, (cmd: string) => {
      term.writeln("");
      term.writeln(`\x1b[32m${prompt}\x1b[0m ${cmd}`);
      getMockCommandOutput(cmd, resourceName).forEach((line) => term.writeln(line));
    });

    return () => {
      onSenderChange(sessionId, null);
      setStatus(sessionId, "disconnected");
      term.dispose();
      termRef.current = null;
    };
  }, [onSenderChange, resource, sessionId, setStatus, startup]);

  return <div ref={containerRef} className="term-xterm-wrap" />;
}

function CommandInput({ onSend }: { onSend: (cmd: string) => void }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useI18n();

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  }, [onSend, value]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 100)}px`;
  }, [value]);

  return (
    <div className="term-cmd-input">
      <span className="term-cmd-prompt">&gt;</span>
      <textarea
        ref={textareaRef}
        className="term-cmd-textarea"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t("terminal.command.placeholder")}
        rows={1}
        spellCheck={false}
      />
      <button className="btn-icon term-cmd-send" onClick={submit} title={t("terminal.command.send")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M22 2L11 13" />
          <path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    </div>
  );
}

function countLeafPanes(layout: PaneLayout | null): number {
  if (!layout) return 0;
  if (layout.type === "leaf") return 1;
  return layout.children.reduce((total, child) => total + countLeafPanes(child), 0);
}

function getLayoutKey(layout: PaneLayout): string {
  if (layout.type === "leaf") return layout.paneId;
  return `${layout.direction}:${layout.children.map(getLayoutKey).join("|")}`;
}

function normalizeSizes(sizes: number[], childCount: number): number[] {
  if (sizes.length !== childCount || childCount === 0) {
    return Array.from({ length: childCount }, () => 100 / Math.max(childCount, 1));
  }
  const total = sizes.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return Array.from({ length: childCount }, () => 100 / Math.max(childCount, 1));
  }
  return sizes.map((value) => (value / total) * 100);
}

function updateSplitSizes(layout: PaneLayout, targetKey: string, sizes: number[]): PaneLayout {
  if (layout.type === "leaf") return layout;
  const layoutKey = getLayoutKey(layout);
  if (layoutKey === targetKey) {
    return { ...layout, sizes: normalizeSizes(sizes, layout.children.length) };
  }
  return {
    ...layout,
    children: layout.children.map((child) => updateSplitSizes(child, targetKey, sizes)),
  };
}

function swapPaneLayout(layout: PaneLayout, sourcePaneId: string, targetPaneId: string): PaneLayout {
  if (layout.type === "leaf") {
    if (layout.paneId === sourcePaneId) {
      return { ...layout, paneId: targetPaneId };
    }
    if (layout.paneId === targetPaneId) {
      return { ...layout, paneId: sourcePaneId };
    }
    return layout;
  }
  return {
    ...layout,
    children: layout.children.map((child) => swapPaneLayout(child, sourcePaneId, targetPaneId)),
  };
}

function PaneSplitContainer({
  direction,
  children,
  childKeys,
  initialSizes,
  onSizesChange,
}: {
  direction: "horizontal" | "vertical";
  children: ReactNode[];
  childKeys: string[];
  initialSizes?: number[];
  onSizesChange?: (sizes: number[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(() => normalizeSizes(initialSizes ?? [], children.length));
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const dragRef = useRef<{ index: number; startPos: number; startSizes: number[] } | null>(null);
  const sizesRef = useRef<number[]>(normalizeSizes(initialSizes ?? [], children.length));

  useEffect(() => {
    const nextSizes = normalizeSizes(initialSizes ?? [], children.length);
    sizesRef.current = nextSizes;
    setSizes(nextSizes);
  }, [children.length, childKeys.join("|"), initialSizes]);

  const handleMouseDown = useCallback(
    (index: number, clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return;

      dragRef.current = {
        index,
        startPos: direction === "horizontal" ? clientX : clientY,
        startSizes: [...sizes],
      };
      setDraggingIndex(index);

      const handleMouseMove = (event: MouseEvent) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerSize = direction === "horizontal" ? containerRef.current.clientWidth : containerRef.current.clientHeight;
        const currentPos = direction === "horizontal" ? event.clientX : event.clientY;
        const delta = ((currentPos - dragRef.current.startPos) / Math.max(containerSize, 1)) * 100;

        setSizes((previous) => {
          const next = [...previous];
          const combined = dragRef.current!.startSizes[index] + dragRef.current!.startSizes[index + 1];
          let before = dragRef.current!.startSizes[index] + delta;
          let after = dragRef.current!.startSizes[index + 1] - delta;

          if (before < 18) {
            before = 18;
            after = combined - 18;
          }
          if (after < 18) {
            after = 18;
            before = combined - 18;
          }

          next[index] = before;
          next[index + 1] = after;
          sizesRef.current = next;
          return next;
        });
      };

      const handleMouseUp = () => {
        if (dragRef.current) {
          const finalSizes = normalizeSizes(sizesRef.current, children.length);
          sizesRef.current = finalSizes;
          onSizesChange?.(finalSizes);
        }
        dragRef.current = null;
        setDraggingIndex(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [children.length, direction, onSizesChange, sizes]
  );

  const isHorizontal = direction === "horizontal";

  return (
    <div ref={containerRef} className={`term-split-container ${isHorizontal ? "horizontal" : "vertical"}`}>
      {children.map((child, index) => (
        <Fragment key={childKeys[index]}>
          <div className="term-split-segment" style={{ flex: `${sizes[index]} 1 0%` }}>
            {child}
          </div>
          {index < children.length - 1 ? (
            <button
              type="button"
              className={`term-drag-handle ${isHorizontal ? "horizontal" : "vertical"}${draggingIndex === index ? " dragging" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                handleMouseDown(index, event.clientX, event.clientY);
              }}
              aria-label={isHorizontal ? "调整左右分栏宽度" : "调整上下分栏高度"}
            >
              <span className="term-drag-grip" />
            </button>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function TerminalPaneTree({
  tab,
  layout,
  workspaceFallbackResource,
  totalPanes,
  draggingPaneId,
  dropTargetPaneId,
  onActivatePane,
  onSendCommand,
  onSenderChange,
  onStartDragPane,
  onEndDragPane,
  onSetDropTargetPane,
  onSwapPanes,
  onResizeSplit,
}: {
  tab: TerminalTab;
  layout: PaneLayout;
  workspaceFallbackResource: WorkspaceResource | null;
  totalPanes: number;
  draggingPaneId: string | null;
  dropTargetPaneId: string | null;
  onActivatePane: (paneId: string) => void;
  onSendCommand: (command: string, paneId: string) => void;
  onSenderChange: (sessionId: string, sender: ((cmd: string) => void) | null) => void;
  onStartDragPane: (paneId: string) => void;
  onEndDragPane: () => void;
  onSetDropTargetPane: (paneId: string | null) => void;
  onSwapPanes: (sourcePaneId: string, targetPaneId: string) => void;
  onResizeSplit: (layoutKey: string, sizes: number[]) => void;
}) {
  const panesById = useMemo(() => new Map(tab.panes.map((pane) => [pane.id, pane])), [tab.panes]);

  if (layout.type === "leaf") {
    const pane = panesById.get(layout.paneId);
    if (!pane) return null;

    const resource = getResourceById(pane.resourceId) ?? workspaceFallbackResource;
    const blueprint = getBlueprint(resource, pane);
    const resourceName = resource?.name ?? "omnipanel";
    const envClass = `env-${resource?.environment ?? "local"}`;
    const shellName = pane.shellLabel ?? (isTauriRuntime ? "bash" : "PowerShell");
    const currentPath = pane.cwd ?? "~";
    const isActive = pane.id === tab.activePaneId;
    const isDragging = draggingPaneId === pane.id;
    const isDropTarget = dropTargetPaneId === pane.id && draggingPaneId !== pane.id;

    return (
      <div
        className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}${isDragging ? " is-dragging" : ""}${isDropTarget ? " is-drop-target" : ""}`}
        onMouseDown={() => onActivatePane(pane.id)}
        onDragOver={(event) => {
          if (!draggingPaneId || draggingPaneId === pane.id) return;
          event.preventDefault();
          onSetDropTargetPane(pane.id);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!draggingPaneId || draggingPaneId === pane.id) return;
          onSwapPanes(draggingPaneId, pane.id);
          onSetDropTargetPane(null);
          onEndDragPane();
        }}
      >
        <div
          className="term-pane-header term-pane-header--main term-pane-header--draggable"
          draggable={totalPanes > 1}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", pane.id);
            onStartDragPane(pane.id);
          }}
          onDragEnd={() => {
            onSetDropTargetPane(null);
            onEndDragPane();
          }}
        >
          <span className={`env-badge ${envClass}`}>{resource?.environment ?? "local"}</span>
          <span className="host">{resourceName}</span>
          <span className="term-pane-meta">{pane.title}</span>
          <span className="text-muted">·</span>
          <span className="text-accent">{currentPath}</span>
          <span className={`term-pane-status ${pane.status === "connected" ? "accent" : pane.status === "connecting" ? "warn" : "muted"}`}>
            {pane.status === "connected" ? "Connected" : pane.status === "connecting" ? "Connecting" : "Disconnected"}
          </span>
          <span className="text-muted term-pane-shell-label">{shellName}</span>
          {totalPanes > 1 ? <span className="term-pane-index">Pane</span> : null}
        </div>
        <div className="terminal-area term-terminal-shell">
          <TerminalView sessionId={pane.id} resource={resource} startup={blueprint.startup} onSenderChange={onSenderChange} />
        </div>
        <CommandInput onSend={(command) => onSendCommand(command, pane.id)} />
      </div>
    );
  }

  const childKeys = layout.children.map(getLayoutKey);
  const layoutKey = getLayoutKey(layout);

  return (
    <PaneSplitContainer direction={layout.direction} childKeys={childKeys} initialSizes={layout.sizes} onSizesChange={(sizes) => onResizeSplit(layoutKey, sizes)}>
      {layout.children.map((child) => (
        <TerminalPaneTree
          key={getLayoutKey(child)}
          tab={tab}
          layout={child}
          workspaceFallbackResource={workspaceFallbackResource}
          totalPanes={totalPanes}
          draggingPaneId={draggingPaneId}
          dropTargetPaneId={dropTargetPaneId}
          onActivatePane={onActivatePane}
          onSendCommand={onSendCommand}
          onSenderChange={onSenderChange}
          onStartDragPane={onStartDragPane}
          onEndDragPane={onEndDragPane}
          onSetDropTargetPane={onSetDropTargetPane}
          onSwapPanes={onSwapPanes}
          onResizeSplit={onResizeSplit}
        />
      ))}
    </PaneSplitContainer>
  );
}

function TerminalCopilotBridge({
  onOpenAi,
  onPinAi,
  promptActions,
}: {
  onOpenAi: (prompt?: string, pinned?: boolean) => void;
  onPinAi: () => void;
  promptActions: Array<{ label: string; prompt: string }>;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h3>AI 操作</h3>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <div className="term-command-pack">
          {promptActions.map((item) => (
            <button key={item.label} type="button" className="term-command-chip" onClick={() => onOpenAi(item.prompt)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenAi()}>
            打开 AI
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onPinAi}>
            固定 AI
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionWorkbenchPane({
  tab,
  resource,
  blueprint,
  onCommand,
  onNavigate,
  onOpenAi,
  onPinAi,
}: {
  tab: TerminalPane;
  resource: WorkspaceResource | null;
  blueprint: ReturnType<typeof getBlueprint>;
  onCommand: (command: string) => void;
  onNavigate: (path: string, resourceId?: string) => void;
  onOpenAi: (prompt?: string, pinned?: boolean) => void;
  onPinAi: () => void;
}) {
  return (
    <div className="term-side-stack">
      <div className="panel">
        <div className="panel-header">
          <h3>快捷命令</h3>
        </div>
        <div className="panel-body term-command-pack">
          {blueprint.commandPack.map((command) => (
            <button key={command} type="button" className="term-command-chip" onClick={() => onCommand(command)}>
              {command}
            </button>
          ))}
        </div>
      </div>

      {blueprint.relatedModules.length > 0 ? (
        <div className="panel">
          <div className="panel-header">
            <h3>模块联动</h3>
          </div>
          <div className="panel-body term-linked-list">
            {blueprint.relatedModules.map((item) => (
              <button key={`${item.path}-${item.label}`} type="button" className="term-linked-item" onClick={() => onNavigate(item.path, item.resourceId)}>
                <span>{item.label}</span>
                <span className="text-muted">{item.path}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <TerminalCopilotBridge
        onOpenAi={onOpenAi}
        onPinAi={onPinAi}
        promptActions={[
          { label: "解释当前输出", prompt: `请基于 ${resource?.name ?? tab.title} 当前终端上下文，解释我刚看到的输出和状态。` },
          { label: "生成下一条命令", prompt: `请结合 ${resource?.name ?? tab.title} 当前终端场景，给我下一条最合适执行的命令，并说明原因。` },
          { label: "整理排查步骤", prompt: `请针对 ${resource?.name ?? tab.title} 当前场景，整理一个最小化排查步骤列表。` },
        ]}
      />
    </div>
  );
}

type LayoutPreset = "single" | "columns" | "rows" | "left-stack" | "right-stack" | "top-stack" | "bottom-stack" | "grid";

function isLeaf(layout: PaneLayout): layout is Extract<PaneLayout, { type: "leaf" }> {
  return layout.type === "leaf";
}

function paneCountForPreset(preset: LayoutPreset) {
  if (preset === "single") return 1;
  if (preset === "left-stack" || preset === "right-stack" || preset === "top-stack" || preset === "bottom-stack") return 3;
  if (preset === "grid") return 4;
  return 2;
}

function detectLayoutPreset(layout: PaneLayout): LayoutPreset | null {
  if (layout.type === "leaf") return "single";
  if (layout.children.length !== 2) return null;

  const [first, second] = layout.children;

  if (layout.direction === "horizontal") {
    if (isLeaf(first) && isLeaf(second)) return "columns";
    if (first.type === "split" && first.direction === "vertical" && first.children.length === 2 && first.children.every(isLeaf) && isLeaf(second)) {
      return "right-stack";
    }
    if (isLeaf(first) && second.type === "split" && second.direction === "vertical" && second.children.length === 2 && second.children.every(isLeaf)) {
      return "left-stack";
    }
    if (first.type === "split" && first.direction === "vertical" && first.children.length === 2 && first.children.every(isLeaf) && second.type === "split" && second.direction === "vertical" && second.children.length === 2 && second.children.every(isLeaf)) {
      return "grid";
    }
  }

  if (layout.direction === "vertical") {
    if (isLeaf(first) && isLeaf(second)) return "rows";
    if (first.type === "split" && first.direction === "horizontal" && first.children.length === 2 && first.children.every(isLeaf) && isLeaf(second)) {
      return "bottom-stack";
    }
    if (isLeaf(first) && second.type === "split" && second.direction === "horizontal" && second.children.length === 2 && second.children.every(isLeaf)) {
      return "top-stack";
    }
  }

  return null;
}

function buildPresetLayout(paneIds: string[], preset: LayoutPreset): PaneLayout {
  switch (preset) {
    case "columns":
      return { type: "split", direction: "horizontal", children: [{ type: "leaf", paneId: paneIds[0] }, { type: "leaf", paneId: paneIds[1] }] };
    case "rows":
      return { type: "split", direction: "vertical", children: [{ type: "leaf", paneId: paneIds[0] }, { type: "leaf", paneId: paneIds[1] }] };
    case "left-stack":
      return {
        type: "split",
        direction: "horizontal",
        children: [
          { type: "leaf", paneId: paneIds[0] },
          {
            type: "split",
            direction: "vertical",
            children: [{ type: "leaf", paneId: paneIds[1] }, { type: "leaf", paneId: paneIds[2] }],
          },
        ],
      };
    case "right-stack":
      return {
        type: "split",
        direction: "horizontal",
        children: [
          {
            type: "split",
            direction: "vertical",
            children: [{ type: "leaf", paneId: paneIds[0] }, { type: "leaf", paneId: paneIds[1] }],
          },
          { type: "leaf", paneId: paneIds[2] },
        ],
      };
    case "top-stack":
      return {
        type: "split",
        direction: "vertical",
        children: [
          { type: "leaf", paneId: paneIds[0] },
          {
            type: "split",
            direction: "horizontal",
            children: [{ type: "leaf", paneId: paneIds[1] }, { type: "leaf", paneId: paneIds[2] }],
          },
        ],
      };
    case "bottom-stack":
      return {
        type: "split",
        direction: "vertical",
        children: [
          {
            type: "split",
            direction: "horizontal",
            children: [{ type: "leaf", paneId: paneIds[0] }, { type: "leaf", paneId: paneIds[1] }],
          },
          { type: "leaf", paneId: paneIds[2] },
        ],
      };
    case "grid":
      return {
        type: "split",
        direction: "horizontal",
        children: [
          {
            type: "split",
            direction: "vertical",
            children: [{ type: "leaf", paneId: paneIds[0] }, { type: "leaf", paneId: paneIds[1] }],
          },
          {
            type: "split",
            direction: "vertical",
            children: [{ type: "leaf", paneId: paneIds[2] }, { type: "leaf", paneId: paneIds[3] }],
          },
        ],
      };
    case "single":
    default:
      return { type: "leaf", paneId: paneIds[0] };
  }
}

export function TerminalPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const isActiveRoute = location.pathname === "/terminal";
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const addTab = useTerminalStore((state) => state.addTab);
  const removeTab = useTerminalStore((state) => state.removeTab);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setActivePane = useTerminalStore((state) => state.setActivePane);
  const replaceTabLayout = useTerminalStore((state) => state.replaceTabLayout);
  const updateTabLayout = useTerminalStore((state) => state.updateTabLayout);
  const workspaceActiveResourceId = useWorkspaceStore((state) => state.activeResourceId);
  const workspaceActiveResource = getResourceById(workspaceActiveResourceId) ?? getResourceById("local-terminal");
  const selectResource = useWorkspaceStore((state) => state.selectResource);
  const setActivePath = useWorkspaceStore((state) => state.setActivePath);
  const enqueueAction = useActionStore((state) => state.enqueueAction);
  const openAiDrawer = useAiStore((state) => state.openDrawer);
  const aiDrawerOpen = useAiStore((state) => state.drawerOpen);
  const aiDrawerMode = useAiStore((state) => state.drawerMode);
  const setAiDrawerMode = useAiStore((state) => state.setDrawerMode);
  const createAiConversation = useAiStore((state) => state.createConversation);
  const activeAiConversationId = useAiStore((state) => state.activeConversationId);
  const setActiveConversation = useAiStore((state) => state.setActiveConversation);
  const addAiContext = useAiStore((state) => state.addContext);
  const setDraftPrompt = useAiStore((state) => state.setDraftPrompt);
  const paneSendersRef = useRef<Record<string, (cmd: string) => void>>({});
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const sshHosts = useMemo(() => getSshHosts(), []);

  useEffect(() => {
    if (tabs.length > 0) return;
    const id = `tab-${tabCounter++}`;
    addTab(
      {
        id,
        title: workspaceActiveResource?.name ?? "本地终端",
        type: "local",
        resourceId: "local-terminal",
        shellLabel: "PowerShell",
        cwd: "~/workspace",
        purpose: "Local Workspace",
        commandPack: [],
      },
      { title: workspaceActiveResource?.name ?? "本地终端" }
    );
    setActiveTab(id);
  }, [addTab, setActiveTab, tabs.length, workspaceActiveResource?.name]);

  const activeWorkspaceTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null, [tabs, activeTabId]);
  const activePane = useMemo(
    () => activeWorkspaceTab?.panes.find((pane) => pane.id === activeWorkspaceTab.activePaneId) ?? activeWorkspaceTab?.panes[0] ?? null,
    [activeWorkspaceTab]
  );
  const activeResource = getResourceById(activePane?.resourceId) ?? workspaceActiveResource;
  const sessionBlueprint = getBlueprint(activeResource, activePane);
  const resourceName = activeResource?.name ?? "omnipanel";
  const envClass = `env-${activeResource?.environment ?? "local"}`;
  const activePaneCount = activeWorkspaceTab?.panes.length ?? 0;
  const activeLayoutPreset = useMemo(
    () => (activeWorkspaceTab ? detectLayoutPreset(activeWorkspaceTab.layout) : null),
    [activeWorkspaceTab]
  );

  useEffect(() => {
    if (!isActiveRoute || !activePane?.resourceId) return;
    if (activePane.resourceId !== workspaceActiveResourceId) {
      selectResource(activePane.resourceId);
    }
  }, [activePane?.resourceId, isActiveRoute, selectResource, workspaceActiveResourceId]);

  useEffect(() => {
    setDraggingPaneId(null);
    setDropTargetPaneId(null);
  }, [activeWorkspaceTab?.id]);

  const isPinnedAi = aiDrawerOpen && aiDrawerMode === "pinned";
  const shellName = activePane?.shellLabel ?? (isTauriRuntime ? "bash" : "PowerShell");

  const handleAddLocalTab = useCallback(() => {
    const id = createTerminalTabId();
    addTab(
      {
        id,
        title: `local-${tabs.length + 1}`,
        type: "local",
        resourceId: "local-terminal",
        shellLabel: "PowerShell",
        cwd: "~/workspace",
        purpose: "Local Workspace",
        commandPack: [],
      },
      { title: `本地终端 ${tabs.length + 1}` }
    );
    setActiveTab(id);
  }, [addTab, setActiveTab, tabs.length]);

  const handleCloseTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      removeTab(id);
    },
    [tabs.length, removeTab]
  );

  const addMenuItems = useMemo(
    () => [
      {
        id: "local",
        label: t("terminal.newSession.local"),
        subtitle: t("terminal.newSession.localDesc"),
      },
      ...sshHosts.map((host) => ({
        id: host.id,
        label: host.name,
        subtitle: host.subtitle,
      })),
      {
        id: "manage-hosts",
        label: t("terminal.newSession.manageHosts"),
        subtitle: t("terminal.newSession.manageHostsDesc"),
        dividerBefore: true,
      },
    ],
    [sshHosts, t]
  );

  const handleAddMenuSelect = useCallback(
    (id: string) => {
      if (id === "local") {
        handleAddLocalTab();
        return;
      }
      if (id === "manage-hosts") {
        navigate("/ssh");
        return;
      }
      openSshTerminalSession(id);
    },
    [handleAddLocalTab, navigate]
  );

  const topbarTabs = useMemo(
    () =>
      tabs.map((tab) => {
        const pane = tab.panes.find((item) => item.id === tab.activePaneId) ?? tab.panes[0];
        return {
          id: tab.id,
          label: tabLabel(tab),
          active: tab.id === activeTabId,
          closable: tabs.length > 1,
          status: pane?.status === "disconnected" ? ("offline" as const) : pane?.status ?? ("offline" as const),
        };
      }),
    [tabs, activeTabId]
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: setActiveTab,
      onClose: handleCloseTab,
      addMenuItems,
      onAddMenuSelect: handleAddMenuSelect,
    },
    { mode: "session", showAddTab: true, enabled: isActiveRoute }
  );

  const handlePaneSenderChange = useCallback((sessionId: string, sender: ((cmd: string) => void) | null) => {
    if (sender) {
      paneSendersRef.current[sessionId] = sender;
      return;
    }
    delete paneSendersRef.current[sessionId];
  }, []);

  const handleCommand = useCallback(
    (command: string, paneId?: string) => {
      const targetPaneId = paneId ?? activePane?.id;
      if (!targetPaneId) return;

      const targetTab = tabs.find((tab) => tab.panes.some((pane) => pane.id === targetPaneId));
      const targetPane = targetTab?.panes.find((pane) => pane.id === targetPaneId);
      if (!targetTab || !targetPane) return;
      const targetResource = getResourceById(targetPane.resourceId) ?? workspaceActiveResource;

      paneSendersRef.current[targetPaneId]?.(command);
      enqueueAction({
        type: "terminal",
        title: t("terminal.actions.command"),
        description: `${targetTab.title} · ${command}`,
        command,
        resourceId: targetResource?.id ?? targetPane.resourceId,
        source: "用户",
      });
    },
    [activePane?.id, enqueueAction, tabs, t, workspaceActiveResource]
  );

  const handleApplyLayoutPreset = useCallback(
    (preset: LayoutPreset) => {
      if (!activeWorkspaceTab || !activePane) return;
      const targetCount = paneCountForPreset(preset);
      const existing = [...activeWorkspaceTab.panes];
      const nextPanes = existing.slice(0, targetCount);

      while (nextPanes.length < targetCount) {
        const index = nextPanes.length + 1;
        nextPanes.push({
          ...activePane,
          id: `${activeWorkspaceTab.id}-pane-${tabCounter++}`,
          title: `${activePane.title} ${index}`,
          terminal: null,
          status: "connecting",
          backendSessionId: null,
        });
      }

      const nextActivePaneId = nextPanes.some((pane) => pane.id === activeWorkspaceTab.activePaneId)
        ? activeWorkspaceTab.activePaneId
        : nextPanes[0].id;

      replaceTabLayout(
        activeWorkspaceTab.id,
        nextPanes,
        buildPresetLayout(nextPanes.map((pane) => pane.id), preset),
        nextActivePaneId
      );
      setDraggingPaneId(null);
      setDropTargetPaneId(null);
    },
    [activePane, activeWorkspaceTab, replaceTabLayout]
  );

  const handleResizeSplit = useCallback(
    (layoutKey: string, sizes: number[]) => {
      if (!activeWorkspaceTab) return;
      updateTabLayout(activeWorkspaceTab.id, updateSplitSizes(activeWorkspaceTab.layout, layoutKey, sizes));
    },
    [activeWorkspaceTab, updateTabLayout]
  );

  const handleSwapPanes = useCallback(
    (sourcePaneId: string, targetPaneId: string) => {
      if (!activeWorkspaceTab || sourcePaneId === targetPaneId) return;
      updateTabLayout(activeWorkspaceTab.id, swapPaneLayout(activeWorkspaceTab.layout, sourcePaneId, targetPaneId));
      setActivePane(activeWorkspaceTab.id, sourcePaneId);
    },
    [activeWorkspaceTab, setActivePane, updateTabLayout]
  );

  const handleModuleNavigate = useCallback(
    (path: string, resourceId?: string) => {
      if (resourceId) {
        selectResource(resourceId);
      }
      setActivePath(path);
      navigate(path);
    },
    [navigate, selectResource, setActivePath]
  );

  const handleOpenAi = useCallback(
    (prompt?: string, pinned = false) => {
      const conversationId = prompt || !activeAiConversationId ? createAiConversation() : activeAiConversationId;
      setActiveConversation(conversationId);
      addAiContext(conversationId, { type: "terminal", label: activePane?.title ?? resourceName });
      addAiContext(conversationId, { type: "shell", label: shellName });
      if (activeResource) {
        addAiContext(conversationId, { type: "resource", label: activeResource.name });
      }
      if (prompt) {
        setDraftPrompt(prompt);
      }
      setAiDrawerMode(pinned ? "pinned" : "drawer");
      openAiDrawer();
    },
    [activeAiConversationId, activePane?.title, activeResource, addAiContext, createAiConversation, openAiDrawer, resourceName, setActiveConversation, setAiDrawerMode, setDraftPrompt, shellName]
  );

  if (!activeWorkspaceTab || !activePane) return null;

  return (
    <div className="term-workspace">
      <div className="term-panes">
        <div className="term-pane term-pane--main term-pane--canvas">
          <div className="term-layout-strip">
            <div className="term-layout-group">
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "single" ? " active" : ""}`} title="单栏" onClick={() => handleApplyLayoutPreset("single")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "columns" ? " active" : ""}`} title="左右分栏" onClick={() => handleApplyLayoutPreset("columns")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "rows" ? " active" : ""}`} title="上下分栏" onClick={() => handleApplyLayoutPreset("rows")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "left-stack" ? " active" : ""}`} title="左右 1 + 2" onClick={() => handleApplyLayoutPreset("left-stack")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="7" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="13" width="8" height="7" rx="1.5" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "right-stack" ? " active" : ""}`} title="左右 2 + 1" onClick={() => handleApplyLayoutPreset("right-stack")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="3" y="13" width="8" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="16" rx="1.5" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "top-stack" ? " active" : ""}`} title="上下 1 + 2" onClick={() => handleApplyLayoutPreset("top-stack")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="8" height="6" rx="1.5" /><rect x="13" y="14" width="8" height="6" rx="1.5" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "bottom-stack" ? " active" : ""}`} title="上下 2 + 1" onClick={() => handleApplyLayoutPreset("bottom-stack")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="8" height="6" rx="1.5" /><rect x="13" y="4" width="8" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /></svg>
              </button>
              <button type="button" className={`term-layout-btn${activeLayoutPreset === "grid" ? " active" : ""}`} title="2 + 2" onClick={() => handleApplyLayoutPreset("grid")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" /><rect x="3" y="13" width="8" height="7" rx="1.5" /><rect x="13" y="13" width="8" height="7" rx="1.5" /></svg>
              </button>
            </div>
            <span className="term-layout-meta">{activeWorkspaceTab.title} · {activePaneCount} panes · 拖拽中间分隔条调整尺寸</span>
          </div>
          {isPinnedAi ? (
            <div className="term-focus-strip">
              <div className="term-focus-strip-section">
                {sessionBlueprint.commandPack.slice(0, 3).map((command) => (
                  <button key={command} type="button" className="term-command-chip" onClick={() => handleCommand(command, activePane.id)}>
                    {command}
                  </button>
                ))}
              </div>
              <span className="term-focus-hint">当前标签独立维护自己的分栏布局</span>
            </div>
          ) : null}
          <div className="term-pane-tree-shell">
            <TerminalPaneTree
              tab={activeWorkspaceTab}
              layout={activeWorkspaceTab.layout}
              workspaceFallbackResource={workspaceActiveResource}
              totalPanes={countLeafPanes(activeWorkspaceTab.layout)}
              draggingPaneId={draggingPaneId}
              dropTargetPaneId={dropTargetPaneId}
              onActivatePane={(paneId) => setActivePane(activeWorkspaceTab.id, paneId)}
              onSendCommand={handleCommand}
              onSenderChange={handlePaneSenderChange}
              onStartDragPane={setDraggingPaneId}
              onEndDragPane={() => setDraggingPaneId(null)}
              onSetDropTargetPane={setDropTargetPaneId}
              onSwapPanes={handleSwapPanes}
              onResizeSplit={handleResizeSplit}
            />
          </div>
        </div>

        {!isPinnedAi ? (
          <>
            <div className="term-split-handle" />

            <div className="term-pane term-pane--side">
              <div className="term-pane-header">
                <span className={`env-badge ${activePane.type === "remote" ? envClass : "env-dev"}`}>{activePane.type === "remote" ? "ssh" : "ops"}</span>
                <span className="host">{activePane.type === "remote" ? "session-orchestrator" : "workspace-helper"}</span>
                <span className="text-muted">:</span>
                <span className="text-accent">{activePane.purpose}</span>
                <span className="text-muted" style={{ marginLeft: "auto" }}>
                  {activePaneCount > 1 ? `${activePaneCount} panes` : "workbench"}
                </span>
              </div>
              <SessionWorkbenchPane
                tab={activePane}
                resource={activeResource}
                blueprint={sessionBlueprint}
                onCommand={(command) => handleCommand(command, activePane.id)}
                onNavigate={handleModuleNavigate}
                onOpenAi={handleOpenAi}
                onPinAi={() => handleOpenAi(undefined, true)}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

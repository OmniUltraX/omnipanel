import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import {
  useTerminalStore,
  type TerminalPane,
  type TerminalTab,
} from "../../stores/terminalStore";
import {
  useTerminal,
  disposePaneBackendSession,
  disposeTabBackendSessions,
} from "../../hooks/useTerminal";
import {
  getResourceById,
  getSshHosts,
  type WorkspaceResource,
} from "../../lib/resourceRegistry";
import { openSshTerminalSession } from "../../lib/terminalSession";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { DockLayout, DockPanel, DockHandle } from "../../components/dock";

let splitNodeCounter = 0;

/** 在同一 tab 内生成唯一 pane id（避免 HMR 重置模块计数器后重复 key） */
function createUniquePaneId(tabId: string, panes: { id: string }[]): string {
  const used = new Set(panes.map((pane) => pane.id));
  let index = 0;
  let id = `${tabId}-pane-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${tabId}-pane-${index}`;
  }
  return id;
}

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function tabLabel(tab: TerminalTab) {
  const pane =
    tab.panes.find((item) => item.id === tab.activePaneId) ?? tab.panes[0];
  if (!pane) return tab.title;
  const resource = getResourceById(pane.resourceId);
  return formatPaneHeaderTitle(resource, pane);
}

/** 窗格标题：避免资源名与 pane.title 重复堆叠 */
function formatPaneHeaderTitle(
  resource: WorkspaceResource | null,
  pane: TerminalPane,
): string {
  const base = resource?.name ?? pane.title;
  if (pane.title && pane.title !== base) {
    return pane.title;
  }
  return base;
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
    goals: [
      "运行本地构建或脚本",
      "接收 SSH / Docker 模块推送的指令",
      "与工作流执行记录联动",
    ],
    commandPack: ["npm run dev", "npm run build", "git status"],
    relatedModules: [],
    startup: ["本地会话已就绪，可直接执行开发命令。"],
  },
  "prod-web-01": {
    summary: "生产入口节点，聚焦容器巡检、日志排障与发布验证。",
    facts: ["4 个核心容器", "2 条 SSH Tunnel", "nginx + app + redis"],
    goals: [
      "先看容器与健康检查",
      "确认 nginx 与 upstream 状态",
      "必要时切换到部署工作流",
    ],
    commandPack: [
      'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
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
    goals: [
      "验证灰度版本状态",
      "检查 nginx reload 结果",
      "必要时回到主站对比",
    ],
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
    goals: [
      "确认中转路径可用",
      "检查预发 API 与 worker 状态",
      "整理审计上下文",
    ],
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
    summary:
      "会话已纳入统一终端工作区，可接收来自 SSH、Docker、Server 的上下文。",
    facts: [],
    goals: [
      "先确认目标资源状态",
      "执行最小必要命令",
      "将下一步动作推入工作流",
    ],
    commandPack: ["pwd", "ls -la", "git status"],
    relatedModules: [],
    startup: ["当前会话可按资源类型切换不同命令包与模块入口。"],
  },
};

function getBlueprint(
  resource: WorkspaceResource | null,
  tab: TerminalPane | null,
) {
  const base =
    SESSION_BLUEPRINTS[resource?.id ?? "default"] ?? SESSION_BLUEPRINTS.default;
  return {
    ...base,
    commandPack: Array.from(
      new Set([...(tab?.commandPack ?? []), ...base.commandPack]),
    ),
    purpose:
      tab?.purpose ??
      (tab?.type === "remote" ? "SSH Workbench" : "Local Workspace"),
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

  if (
    normalized.includes("journalctl") ||
    normalized.includes("docker logs")
  ) {
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

function seedMockTerminal(
  term: Terminal,
  resource: WorkspaceResource | null,
  startup: string[],
) {
  const prompt = getPromptPrefix(resource);
  [
    `\x1b[90mWorkspace attached: ${resource?.name ?? "omnipanel"}\x1b[0m`,
    ...startup.map((line) => `\x1b[36m${line}\x1b[0m`),
    "",
    `\x1b[32m${prompt}\x1b[0m docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`,
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
    "",
    `\x1b[32m${prompt}\x1b[0m `,
  ].forEach((line) => term.writeln(line));
}

// ============================================================
// TerminalView - xterm terminal renderer
// ============================================================

function TerminalView({
  sessionId,
  resource,
  startup,
  active,
  onSenderChange,
}: {
  sessionId: string;
  resource: WorkspaceResource | null;
  startup: string[];
  active: boolean;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<((cmd: string) => void) | null>(null);
  const setStatus = useTerminalStore((state) => state.setStatus);

  useTerminal(
    sessionId,
    containerRef,
    undefined,
    undefined,
    undefined,
    !isTauriRuntime,
    {
      inputMode: "external",
      sendRef,
      active,
    },
  );

  const paneStatus = useTerminalStore((state) =>
    state.tabs.flatMap((tab) => tab.panes).find((pane) => pane.id === sessionId)?.status,
  );

  useEffect(() => {
    if (!isTauriRuntime) return;
    if (!active) {
      onSenderChange(sessionId, null);
      return;
    }
    onSenderChange(sessionId, sendRef.current);
    return () => {
      onSenderChange(sessionId, null);
    };
  }, [active, onSenderChange, paneStatus, sessionId]);

  useEffect(() => {
    if (isTauriRuntime) return;
    const container = containerRef.current;
    if (!container) return;

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
      const prompt = getPromptPrefix(resource);
      const resourceName = resource?.name ?? "omnipanel";
      term.writeln("");
      term.writeln(`\x1b[32m${prompt}\x1b[0m ${cmd}`);
      getMockCommandOutput(cmd, resourceName).forEach((line) => term.writeln(line));
      term.writeln("");
      term.write(`\x1b[32m${prompt}\x1b[0m `);
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

// ============================================================
// CommandInput - 底部命令输入（写入 PTY，输出区显示 shell 真实回显）
// ============================================================

const CMD_INPUT_LINE_HEIGHT_PX = 24;
const CMD_INPUT_MAX_HEIGHT_PX = 100;

function syncCommandInputHeight(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  if (!element.value) {
    element.style.height = `${CMD_INPUT_LINE_HEIGHT_PX}px`;
    return;
  }
  element.style.height = `${Math.min(element.scrollHeight, CMD_INPUT_MAX_HEIGHT_PX)}px`;
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

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    syncCommandInputHeight(element);
  }, [value]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const root = element.closest(".term-cmd-input") ?? element;
    const observer = new ResizeObserver(() => syncCommandInputHeight(element));
    observer.observe(root);
    const onWindowResize = () => syncCommandInputHeight(element);
    window.addEventListener("resize", onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

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
      <button
        className="btn-icon term-cmd-send"
        onClick={submit}
        title={t("terminal.command.send")}
        type="button"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="16"
          height="16"
        >
          <path d="M22 2L11 13" />
          <path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    </div>
  );
}

// ============================================================
// TerminalPaneView - Single terminal pane with header
// ============================================================

type TerminalPaneViewProps = {
  paneId: string;
  resource: WorkspaceResource | null;
  pane: TerminalPane;
  isActive: boolean;
  onActivate: () => void;
  onSendCommand: (command: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  canClose: boolean;
};

function TerminalPaneView({
  paneId,
  resource,
  pane,
  isActive,
  onActivate,
  onSendCommand,
  onSenderChange,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  canClose,
}: TerminalPaneViewProps) {
  const headerTitle = formatPaneHeaderTitle(resource, pane);
  const env = resource?.environment ?? "local";
  const showEnvBadge = env !== "local" && env !== "dev";
  const blueprint = getBlueprint(resource, pane);

  return (
    <div
      className={`term-pane term-pane-leaf${isActive ? " is-active" : ""}`}
      onMouseDown={onActivate}
    >
      <div className="term-pane-header">
        {showEnvBadge && (
          <span className={`env-badge env-${env}`}>{env}</span>
        )}
        <span className="term-pane-title">{headerTitle}</span>
        {pane.status !== "connected" && (
          <span
            className={`term-pane-status ${pane.status === "connecting" ? "warn" : "muted"}`}
          >
            {pane.status === "connecting" ? "连接中" : "已断开"}
          </span>
        )}
        <div className="term-pane-actions">
          <button
            className="btn-icon term-pane-action"
            onClick={(e) => {
              e.stopPropagation();
              onSplitHorizontal();
            }}
            title="左右拆分"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              width="14"
              height="14"
            >
              <rect x="1" y="2" width="14" height="12" rx="1.5" />
              <line x1="8" y1="2" x2="8" y2="14" />
            </svg>
          </button>
          <button
            className="btn-icon term-pane-action"
            onClick={(e) => {
              e.stopPropagation();
              onSplitVertical();
            }}
            title="上下拆分"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              width="14"
              height="14"
            >
              <rect x="1" y="2" width="14" height="12" rx="1.5" />
              <line x1="1" y1="8" x2="15" y2="8" />
            </svg>
          </button>
          {canClose && (
            <button
              className="btn-icon term-pane-action term-pane-action--close"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              title="关闭窗格"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                width="14"
                height="14"
              >
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="terminal-area term-terminal-shell">
        <TerminalView
          sessionId={paneId}
          resource={resource}
          startup={blueprint.startup}
          active={isActive}
          onSenderChange={onSenderChange}
        />
      </div>
      <CommandInput onSend={onSendCommand} />
    </div>
  );
}

// ============================================================
// SplitLayout - Flexible split layout container
// ============================================================

type SplitDirection = "horizontal" | "vertical";

type SplitNode = {
  id: string;
  type: "pane";
  paneId: string;
};

type SplitContainer = {
  id: string;
  type: "split";
  direction: SplitDirection;
  children: Array<SplitNode | SplitContainer>;
  sizes: number[];
};

type LayoutNode = SplitNode | SplitContainer;

function isSplitContainer(node: LayoutNode): node is SplitContainer {
  return node.type === "split";
}

function generateId(): string {
  return `split-${splitNodeCounter++}`;
}

function findPaneNode(tree: LayoutNode, paneId: string): SplitNode | null {
  if (!isSplitContainer(tree)) {
    return tree.paneId === paneId ? tree : null;
  }
  for (const child of tree.children) {
    const found = findPaneNode(child, paneId);
    if (found) return found;
  }
  return null;
}

function findParentOfPane(
  tree: LayoutNode,
  paneId: string,
): SplitContainer | null {
  if (!isSplitContainer(tree)) return null;
  for (const child of tree.children) {
    if (!isSplitContainer(child) && child.paneId === paneId) {
      return tree;
    }
    const found = findParentOfPane(child, paneId);
    if (found) return found;
  }
  return null;
}

function updateNode(
  tree: LayoutNode,
  nodeId: string,
  updater: (node: LayoutNode) => LayoutNode,
): LayoutNode {
  if (tree.id === nodeId) return updater(tree);
  if (isSplitContainer(tree)) {
    return {
      ...tree,
      children: tree.children.map((child) => updateNode(child, nodeId, updater)),
    };
  }
  return tree;
}

function updatePaneNode(
  tree: LayoutNode,
  paneId: string,
  updater: (node: SplitNode) => LayoutNode,
): LayoutNode {
  if (!isSplitContainer(tree)) {
    return tree.paneId === paneId ? updater(tree) : tree;
  }
  let changed = false;
  const children = tree.children.map((child) => {
    const next = updatePaneNode(child, paneId, updater);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...tree, children } : tree;
}

function removePaneNode(tree: LayoutNode, paneId: string): LayoutNode {
  if (!isSplitContainer(tree)) {
    return tree;
  }

  const nextChildren: LayoutNode[] = [];
  const keptSizes: number[] = [];

  tree.children.forEach((child, index) => {
    if (!isSplitContainer(child) && child.paneId === paneId) {
      return;
    }
    const nextChild = isSplitContainer(child)
      ? removePaneNode(child, paneId)
      : child;
    nextChildren.push(nextChild);
    keptSizes.push(tree.sizes[index] ?? 0);
  });

  if (nextChildren.length === tree.children.length) {
    return {
      ...tree,
      children: tree.children.map((child) =>
        isSplitContainer(child) ? removePaneNode(child, paneId) : child,
      ),
    };
  }

  if (nextChildren.length === 1) {
    return nextChildren[0];
  }

  return {
    ...tree,
    children: nextChildren,
    sizes: normalizeSizes(keptSizes, nextChildren.length),
  };
}

function createPaneNode(paneId: string): SplitNode {
  return { id: paneId, type: "pane", paneId };
}

function normalizeSizes(sizes: number[], count: number): number[] {
  if (sizes.length !== count || count === 0) {
    return Array.from({ length: count }, () => 100 / Math.max(count, 1));
  }
  const total = sizes.reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    return Array.from({ length: count }, () => 100 / Math.max(count, 1));
  }
  return sizes.map((v) => (v / total) * 100);
}

// ============================================================
// SplitLayoutRenderer - Renders the split layout tree
// ============================================================

type SplitLayoutRendererProps = {
  node: LayoutNode;
  paneMap: Map<string, TerminalPane>;
  activePaneId: string | null;
  resourceMap: Map<string, WorkspaceResource | null>;
  onActivatePane: (paneId: string) => void;
  onSendCommand: (command: string, paneId: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  totalPanes: number;
};

function SplitLayoutRenderer({
  node,
  paneMap,
  activePaneId,
  resourceMap,
  onActivatePane,
  onSendCommand,
  onSenderChange,
  onSplitPane,
  onClosePane,
  totalPanes,
}: SplitLayoutRendererProps) {
  if (!isSplitContainer(node)) {
    const pane = paneMap.get(node.paneId);
    if (!pane) return null;
    const resource = resourceMap.get(pane.resourceId) ?? null;

    return (
      <TerminalPaneView
        paneId={node.paneId}
        resource={resource}
        pane={pane}
        isActive={node.paneId === activePaneId}
        onActivate={() => onActivatePane(node.paneId)}
        onSendCommand={(cmd) => onSendCommand(cmd, node.paneId)}
        onSenderChange={onSenderChange}
        onSplitHorizontal={() => onSplitPane(node.paneId, "horizontal")}
        onSplitVertical={() => onSplitPane(node.paneId, "vertical")}
        onClose={() => onClosePane(node.paneId)}
        canClose={totalPanes > 1}
      />
    );
  }

  const direction = node.direction;
  const sizes = normalizeSizes(node.sizes, node.children.length);

  const dockChildren: ReactNode[] = [];
  node.children.forEach((child, index) => {
    if (index > 0) {
      dockChildren.push(
        <DockHandle
          key={`${node.id}-handle-${index}`}
          direction={direction}
        />,
      );
    }
    const panelKey = isSplitContainer(child) ? child.id : child.paneId;
    dockChildren.push(
      <DockPanel
        key={`${node.id}-panel-${panelKey}`}
        defaultSize={sizes[index]}
        minSize={10}
        onResize={() => {
          requestAnimationFrame(() => {
            window.dispatchEvent(new Event("resize"));
          });
        }}
      >
        <SplitLayoutRenderer
          node={child}
          paneMap={paneMap}
          activePaneId={activePaneId}
          resourceMap={resourceMap}
          onActivatePane={onActivatePane}
          onSendCommand={onSendCommand}
          onSenderChange={onSenderChange}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          totalPanes={totalPanes}
        />
      </DockPanel>,
    );
  });

  return (
    <DockLayout direction={direction} className="term-split-dock">
      {dockChildren}
    </DockLayout>
  );
}

// ============================================================
// TerminalPanel - Main terminal panel
// ============================================================

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
  const openOrFocusLocalTab = useTerminalStore((state) => state.openOrFocusLocalTab);
  const setActivePane = useTerminalStore((state) => state.setActivePane);
  const workspaceActiveResourceId = useWorkspaceStore(
    (state) => state.activeResourceId,
  );
  const workspaceActiveResource =
    getResourceById(workspaceActiveResourceId) ??
    getResourceById("local-terminal");
  const selectResource = useWorkspaceStore((state) => state.selectResource);
  const enqueueAction = useActionStore((state) => state.enqueueAction);
  const paneSendersRef = useRef<Record<string, (cmd: string) => void>>({});
  const sshHosts = useMemo(() => getSshHosts(), []);

  // Layout state for each tab
  const [layouts, setLayouts] = useState<Record<string, LayoutNode>>({});

  // 本地终端仅保留一个 Tab：统一走 openOrFocusLocalTab，并清理历史重复项
  useEffect(() => {
    const localTabs = tabs.filter((tab) =>
      tab.panes.some(
        (pane) => pane.type === "local" && pane.resourceId === "local-terminal",
      ),
    );

    if (localTabs.length > 1) {
      const keepId =
        activeTabId && localTabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : localTabs[0].id;
      localTabs
        .filter((tab) => tab.id !== keepId)
        .forEach((tab) => {
          disposeTabBackendSessions(tab.id);
          removeTab(tab.id);
        });
      setActiveTab(keepId);
      return;
    }

    if (localTabs.length === 0) {
      const id = openOrFocusLocalTab(
        workspaceActiveResource?.name ?? "本地终端",
      );
      setActiveTab(id);
      return;
    }

    if (!activeTabId) {
      setActiveTab(localTabs[0].id);
    }
  }, [
    activeTabId,
    openOrFocusLocalTab,
    removeTab,
    setActiveTab,
    tabs,
    workspaceActiveResource?.name,
  ]);

  const activeWorkspaceTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  );

  // Initialize layout for new tabs
  useEffect(() => {
    if (!activeWorkspaceTab) return;
    if (!layouts[activeWorkspaceTab.id]) {
      const firstPane = activeWorkspaceTab.panes[0];
      if (firstPane) {
        setLayouts((prev) => ({
          ...prev,
          [activeWorkspaceTab.id]: createPaneNode(firstPane.id),
        }));
      }
    }
  }, [activeWorkspaceTab, layouts]);

  const currentLayout = activeWorkspaceTab
    ? layouts[activeWorkspaceTab.id]
    : null;

  const activePane = useMemo(() => {
    if (!activeWorkspaceTab) return null;
    return (
      activeWorkspaceTab.panes.find(
        (pane) => pane.id === activeWorkspaceTab.activePaneId,
      ) ?? activeWorkspaceTab.panes[0] ?? null
    );
  }, [activeWorkspaceTab]);

  const activeResource =
    getResourceById(activePane?.resourceId) ?? workspaceActiveResource;

  useEffect(() => {
    if (!isActiveRoute || !activePane?.resourceId) return;
    if (activePane.resourceId !== workspaceActiveResourceId) {
      selectResource(activePane.resourceId);
    }
  }, [
    activePane?.resourceId,
    isActiveRoute,
    selectResource,
    workspaceActiveResourceId,
  ]);

  const handleAddLocalTab = useCallback(() => {
    const id = openOrFocusLocalTab(
      workspaceActiveResource?.name ?? "本地终端",
    );
    setActiveTab(id);
  }, [openOrFocusLocalTab, setActiveTab, workspaceActiveResource?.name]);

  const handleCloseTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      disposeTabBackendSessions(id);
      removeTab(id);
      setLayouts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [tabs.length, removeTab],
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
    [sshHosts, t],
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
    [handleAddLocalTab, navigate],
  );

  const topbarTabs = useMemo(
    () =>
      tabs.map((tab) => {
        const pane =
          tab.panes.find((item) => item.id === tab.activePaneId) ??
          tab.panes[0];
        return {
          id: tab.id,
          label: tabLabel(tab),
          active: tab.id === activeTabId,
          closable: tabs.length > 1,
          status:
            pane?.status === "disconnected"
              ? ("offline" as const)
              : (pane?.status ?? ("offline" as const)),
        };
      }),
    [tabs, activeTabId],
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: setActiveTab,
      onClose: handleCloseTab,
      addMenuItems,
      onAddMenuSelect: handleAddMenuSelect,
    },
    { mode: "session", showAddTab: true, enabled: isActiveRoute },
  );

  const handlePaneSenderChange = useCallback(
    (sessionId: string, sender: ((cmd: string) => void) | null) => {
      if (sender) {
        paneSendersRef.current[sessionId] = sender;
        return;
      }
      delete paneSendersRef.current[sessionId];
    },
    [],
  );

  const handleCommand = useCallback(
    (command: string, paneId?: string) => {
      const targetPaneId = paneId ?? activePane?.id;
      if (!targetPaneId) return;

      const targetTab = tabs.find((tab) =>
        tab.panes.some((pane) => pane.id === targetPaneId),
      );
      const targetPane = targetTab?.panes.find(
        (pane) => pane.id === targetPaneId,
      );
      if (!targetTab || !targetPane) return;
      const targetResource =
        getResourceById(targetPane.resourceId) ?? workspaceActiveResource;

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
    [activePane?.id, enqueueAction, tabs, t, workspaceActiveResource],
  );

  const handleSplitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      if (!activeWorkspaceTab) return;

      const sourcePane = activeWorkspaceTab.panes.find(
        (p) => p.id === paneId,
      );
      if (!sourcePane) return;

      const newPaneId = createUniquePaneId(
        activeWorkspaceTab.id,
        activeWorkspaceTab.panes,
      );

      // Create new pane in store
      const newPane: TerminalPane = {
        ...sourcePane,
        id: newPaneId,
        title: `${sourcePane.title} (${activeWorkspaceTab.panes.length + 1})`,
        terminal: null,
        status: "connecting",
        backendSessionId: null,
      };

      // Update layout
      setLayouts((prev) => {
        const currentLayout = prev[activeWorkspaceTab.id];
        if (!currentLayout) return prev;

        if (!findPaneNode(currentLayout, paneId)) return prev;

        // Check if parent is already a split in the same direction
        const parent = findParentOfPane(currentLayout, paneId);
        if (parent && parent.direction === direction) {
          const index = parent.children.findIndex(
            (c) => !isSplitContainer(c) && c.paneId === paneId,
          );
          if (index < 0) return prev;

          const newChildren = [...parent.children];
          newChildren.splice(index + 1, 0, createPaneNode(newPaneId));
          const newSizes = normalizeSizes(
            [...parent.sizes],
            newChildren.length,
          );

          return {
            ...prev,
            [activeWorkspaceTab.id]: updateNode(
              currentLayout,
              parent.id,
              () => ({
                ...parent,
                children: newChildren,
                sizes: newSizes,
              }),
            ),
          };
        }

        const newSplit: SplitContainer = {
          id: generateId(),
          type: "split",
          direction,
          children: [createPaneNode(paneId), createPaneNode(newPaneId)],
          sizes: [50, 50],
        };

        return {
          ...prev,
          [activeWorkspaceTab.id]: updatePaneNode(
            currentLayout,
            paneId,
            () => newSplit,
          ),
        };
      });

      useTerminalStore.getState().addPaneToTab(activeWorkspaceTab.id, newPane);
      setActivePane(activeWorkspaceTab.id, newPaneId);
    },
    [activeWorkspaceTab, setActivePane],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (!activeWorkspaceTab) return;
      const totalPanes = activeWorkspaceTab.panes.length;
      if (totalPanes <= 1) return;

      setLayouts((prev) => {
        const currentLayout = prev[activeWorkspaceTab.id];
        if (!currentLayout) return prev;

        const newLayout = removePaneNode(currentLayout, paneId);
        return {
          ...prev,
          [activeWorkspaceTab.id]: newLayout,
        };
      });

      disposePaneBackendSession(paneId);
      useTerminalStore.getState().removePaneFromTab(activeWorkspaceTab.id, paneId);
    },
    [activeWorkspaceTab],
  );

  const handleActivatePane = useCallback(
    (paneId: string) => {
      if (!activeWorkspaceTab) return;
      setActivePane(activeWorkspaceTab.id, paneId);
    },
    [activeWorkspaceTab, setActivePane],
  );

  if (!activeWorkspaceTab || !activePane || !currentLayout) return null;

  const paneMap = new Map(
    activeWorkspaceTab.panes.map((pane) => [pane.id, pane]),
  );
  const resourceMap = new Map<string, WorkspaceResource | null>();
  for (const pane of activeWorkspaceTab.panes) {
    resourceMap.set(pane.resourceId, getResourceById(pane.resourceId) ?? null);
  }
  const totalPanes = activeWorkspaceTab.panes.length;

  return (
    <div className="term-workspace">
      <div className="term-panes">
        <SplitLayoutRenderer
          node={currentLayout}
          paneMap={paneMap}
          activePaneId={activeWorkspaceTab.activePaneId}
          resourceMap={resourceMap}
          onActivatePane={handleActivatePane}
          onSendCommand={handleCommand}
          onSenderChange={handlePaneSenderChange}
          onSplitPane={handleSplitPane}
          onClosePane={handleClosePane}
          totalPanes={totalPanes}
        />
      </div>
    </div>
  );
}
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { checkCommand, type DangerCheckResult, type DangerLevel } from "../lib/commandGuard";
import { getResourceById, type EnvironmentTag } from "../lib/resourceRegistry";

export type WorkspaceActionStatus = "draft" | "blocked" | "confirmed" | "running" | "completed" | "failed" | "cancelled";

/**
 * 后端执行引擎可直接处理（已注册 executor）的动作类型。其余类型视为记录型，前端即时完成。
 * terminal 不在此列：终端面板命令已在 PTY/SSH 会话中执行，此处仅作审计记录，避免 Windows 上重复 cmd /C 弹窗。
 */
const EXECUTABLE_TYPES = new Set<WorkspaceAction["type"]>(["docker", "server"]);

/** `action-progress` 事件 payload（与后端 omnipanel-exec::ActionProgress 对应；事件类型 specta 不导出，故手定义）。 */
interface ActionProgressEvent {
  actionId: string;
  stream: "stdout" | "stderr" | "status";
  chunk: string;
  status?: "running" | "completed" | "failed" | null;
  exitCode?: number | null;
}

export interface WorkspaceAction {
  id: string;
  type: "terminal" | "sql" | "docker" | "server" | "ssh" | "ai" | "workflow";
  title: string;
  description: string;
  resourceId?: string;
  resourceName?: string;
  environment: EnvironmentTag;
  command?: string;
  risk: DangerLevel;
  riskCheck?: DangerCheckResult;
  status: WorkspaceActionStatus;
  source: "用户" | "AI" | "系统";
  createdAt: number;
}

interface ActionState {
  actions: WorkspaceAction[];
  pendingRiskActionId: string | null;
  /** 每个动作的实时输出行（来自 action-progress 事件）。 */
  logs: Record<string, string[]>;
  enqueueAction: (input: Omit<WorkspaceAction, "id" | "createdAt" | "risk" | "environment" | "status" | "resourceName">) => WorkspaceAction;
  confirmAction: (id: string) => void;
  cancelAction: (id: string) => void;
  completeAction: (id: string) => void;
  failAction: (id: string) => void;
  clearCompleted: () => void;
  /** 触发后端真实执行（命令型动作）或即时完成（记录型动作）。 */
  runAction: (id: string) => void;
}

let actionCounter = 0;

function createActionId() {
  actionCounter += 1;
  return `action-${Date.now()}-${actionCounter}`;
}

function maxDangerLevel(a: DangerLevel, b: DangerLevel): DangerLevel {
  const order: DangerLevel[] = ["low", "medium", "high", "critical"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

export const useActionStore = create<ActionState>((set, get) => ({
  actions: [],
  pendingRiskActionId: null,
  logs: {},

  enqueueAction: (input) => {
    const resource = getResourceById(input.resourceId);
    const environment = resource?.environment ?? "unknown";
    const riskCheck = input.command ? checkCommand(input.command, environment) : undefined;
    const envRisk: DangerLevel = environment === "prod" ? "high" : environment === "staging" ? "medium" : "low";
    const risk = maxDangerLevel(riskCheck?.level ?? "low", envRisk);
    const blocked = risk !== "low";

    const action: WorkspaceAction = {
      ...input,
      id: createActionId(),
      createdAt: Date.now(),
      environment,
      resourceName: resource?.name,
      risk,
      riskCheck,
      status: blocked ? "blocked" : "running",
    };

    set((state) => ({
      actions: [action, ...state.actions].slice(0, 50),
      pendingRiskActionId: blocked ? action.id : state.pendingRiskActionId,
    }));

    // 低风险动作无需确认，直接进入执行。
    if (!blocked) {
      get().runAction(action.id);
    }

    return action;
  },

  confirmAction: (id) => {
    set((state) => ({
      pendingRiskActionId: state.pendingRiskActionId === id ? null : state.pendingRiskActionId,
      actions: state.actions.map((action) =>
        action.id === id ? { ...action, status: "running" } : action
      ),
    }));
    get().runAction(id);
  },

  cancelAction: (id) =>
    set((state) => ({
      pendingRiskActionId: state.pendingRiskActionId === id ? null : state.pendingRiskActionId,
      actions: state.actions.map((action) =>
        action.id === id ? { ...action, status: "cancelled" } : action
      ),
    })),

  completeAction: (id) =>
    set((state) => ({
      actions: state.actions.map((action) =>
        action.id === id ? { ...action, status: "completed" } : action
      ),
    })),

  failAction: (id) =>
    set((state) => ({
      actions: state.actions.map((action) =>
        action.id === id ? { ...action, status: "failed" } : action
      ),
    })),

  clearCompleted: () =>
    set((state) => ({
      actions: state.actions.filter((action) => !["completed", "cancelled"].includes(action.status)),
    })),

  runAction: (id) => {
    const action = get().actions.find((a) => a.id === id);
    if (!action) return;

    // 记录型动作（无命令或非可执行类型，如 workflow/ai/sql/ssh 占位）即时完成。
    if (!action.command || !EXECUTABLE_TYPES.has(action.type)) {
      get().completeAction(id);
      return;
    }

    void commands
      .executeAction({
        id: action.id,
        kind: action.type,
        command: action.command,
        resourceId: action.resourceId ?? null,
        envTag: action.environment,
        cwd: null,
      })
      .then((res) => {
        if (res.status === "ok") {
          if (res.data === 0) get().completeAction(id);
          else get().failAction(id);
        } else {
          set((state) => ({
            logs: { ...state.logs, [id]: [...(state.logs[id] ?? []), `[错误] ${res.error.message}`] },
          }));
          get().failAction(id);
        }
      })
      .catch((e) => {
        set((state) => ({
          logs: { ...state.logs, [id]: [...(state.logs[id] ?? []), `[错误] ${String(e)}`] },
        }));
        get().failAction(id);
      });
  },
}));

export function getPendingRiskAction() {
  const state = useActionStore.getState();
  return state.actions.find((action) => action.id === state.pendingRiskActionId) ?? null;
}

let actionListenerInited = false;

/** 注册 action-progress 事件监听，将后端流式输出写入对应动作的 logs。应用启动时调用一次。 */
export function initActionListener() {
  if (actionListenerInited) return;
  actionListenerInited = true;
  void listen<ActionProgressEvent>("action-progress", (event) => {
    const p = event.payload;
    if (p.stream === "status" || !p.chunk) return;
    const prefix = p.stream === "stderr" ? "[stderr] " : "";
    useActionStore.setState((state) => ({
      logs: { ...state.logs, [p.actionId]: [...(state.logs[p.actionId] ?? []), `${prefix}${p.chunk}`] },
    }));
  }).catch(() => {
    // 非 Tauri 环境忽略
  });
}

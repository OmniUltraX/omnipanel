import { create } from "zustand";
import { checkCommand, type DangerCheckResult, type DangerLevel } from "../lib/commandGuard";
import { getResourceById, type EnvironmentTag } from "../lib/resourceRegistry";

export type WorkspaceActionStatus = "draft" | "blocked" | "confirmed" | "running" | "completed" | "failed" | "cancelled";

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
  enqueueAction: (input: Omit<WorkspaceAction, "id" | "createdAt" | "risk" | "environment" | "status" | "resourceName">) => WorkspaceAction;
  confirmAction: (id: string) => void;
  cancelAction: (id: string) => void;
  completeAction: (id: string) => void;
  failAction: (id: string) => void;
  clearCompleted: () => void;
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

export const useActionStore = create<ActionState>((set) => ({
  actions: [],
  pendingRiskActionId: null,

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

    return action;
  },

  confirmAction: (id) =>
    set((state) => ({
      pendingRiskActionId: state.pendingRiskActionId === id ? null : state.pendingRiskActionId,
      actions: state.actions.map((action) =>
        action.id === id ? { ...action, status: "running" } : action
      ),
    })),

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
}));

export function getPendingRiskAction() {
  const state = useActionStore.getState();
  return state.actions.find((action) => action.id === state.pendingRiskActionId) ?? null;
}

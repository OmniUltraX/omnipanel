import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { requireString, optionalString } from "../../../lib/ai/mcpToolArgs";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { useWorkspaceMembershipStore } from "../../../stores/workspaceMembershipStore";
import { useAiStore } from "../../../stores/aiStore";
import { followAiIntent } from "../../../lib/ai/uiFollow";
import { useConnectionStore } from "../../../stores/connectionStore";

function listAllResourceSummaries(): { id: string; name: string; type: string }[] {
  return useConnectionStore.getState().connections.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.kind,
  }));
}

async function workspaceCreate(args: Record<string, unknown>) {
  const name = requireString(args, "name");
  const description = optionalString(args, "description") ?? "";
  const ws = useWorkspaceStore.getState().addWorkspace(name, description);
  const resourceIdsRaw = args.resource_ids;
  const resourceIds = Array.isArray(resourceIdsRaw)
    ? resourceIdsRaw.filter((x): x is string => typeof x === "string")
    : [];
  if (resourceIds.length > 0) {
    useWorkspaceMembershipStore.getState().addWorkspaceResources(ws.id, resourceIds);
  }
  followAiIntent({ type: "switchWorkspace", workspaceId: ws.id });
  const convId = useAiStore.getState().activeConversationId;
  if (convId) {
    useAiStore.getState().pinConversationWorkspace(convId, ws.id);
  }
  return JSON.stringify({
    ok: true,
    workspaceId: ws.id,
    name: ws.name,
    resourceIds: useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(ws.id),
  });
}

async function workspaceSwitch(args: Record<string, unknown>) {
  const id = requireString(args, "workspace_id");
  const ok = useWorkspaceStore.getState().switchWorkspace(id);
  if (!ok) return `error: 工作区不存在: ${id}`;
  followAiIntent({ type: "switchWorkspace", workspaceId: id });
  return JSON.stringify({ ok: true, workspaceId: id });
}

async function workspaceListResources(args: Record<string, unknown>) {
  const workspaceId = optionalString(args, "workspace_id");
  if (!workspaceId) {
    return JSON.stringify({
      scope: "global",
      resources: listAllResourceSummaries(),
    });
  }
  const ids = useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(workspaceId);
  const all = listAllResourceSummaries();
  const resources = all.filter((r) => ids.includes(r.id));
  return JSON.stringify({ scope: "workspace", workspaceId, resources, memberIds: ids });
}

async function workspaceAddResources(args: Record<string, unknown>) {
  const workspaceId = requireString(args, "workspace_id");
  const raw = args.resource_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return "error: resource_ids 必须为非空字符串数组";
  }
  const resourceIds = raw.filter((x): x is string => typeof x === "string");
  useWorkspaceMembershipStore.getState().addWorkspaceResources(workspaceId, resourceIds);
  return JSON.stringify({
    ok: true,
    workspaceId,
    resourceIds: useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(workspaceId),
  });
}

async function workspaceRemoveResources(args: Record<string, unknown>) {
  const workspaceId = requireString(args, "workspace_id");
  const raw = args.resource_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return "error: resource_ids 必须为非空字符串数组";
  }
  const resourceIds = raw.filter((x): x is string => typeof x === "string");
  useWorkspaceMembershipStore.getState().removeWorkspaceResources(workspaceId, resourceIds);
  return JSON.stringify({
    ok: true,
    workspaceId,
    resourceIds: useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(workspaceId),
  });
}

export const WORKSPACE_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_workspace_create",
    description:
      "创建业务工作区（可选纳入 resource_ids）。工作区非必选；仅当用户明确要求隔离/整理时调用。创建后可切换并钉住当前会话。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "工作区名称" },
        description: { type: "string", description: "可选描述" },
        resource_ids: {
          type: "array",
          items: { type: "string" },
          description: "可选，纳入的连接/资源 id 列表",
        },
      },
      required: ["name"],
    },
    handler: workspaceCreate,
  },
  {
    name: "omni_workspace_switch",
    description: "切换到指定工作区（UI）。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "工作区 id" },
      },
      required: ["workspace_id"],
    },
    handler: workspaceSwitch,
  },
  {
    name: "omni_workspace_list_resources",
    description:
      "列出资源。不传 workspace_id 时返回全局连接；传入时返回该工作区 membership 内资源。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "可选工作区 id；省略=全局" },
      },
    },
    handler: workspaceListResources,
  },
  {
    name: "omni_workspace_add_resources",
    description: "将资源 id 纳入指定工作区 membership。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        resource_ids: { type: "array", items: { type: "string" } },
      },
      required: ["workspace_id", "resource_ids"],
    },
    handler: workspaceAddResources,
  },
  {
    name: "omni_workspace_remove_resources",
    description: "从工作区 membership 移除资源。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        resource_ids: { type: "array", items: { type: "string" } },
      },
      required: ["workspace_id", "resource_ids"],
    },
    handler: workspaceRemoveResources,
  },
];

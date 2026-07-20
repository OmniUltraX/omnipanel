import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { optionalString, requireString } from "../../../lib/ai/mcpToolArgs";
import type {
  DockerContainerDetail,
  DockerContainerSummary,
  DockerLogLine,
} from "../../../ipc/bindings";

/**
 * Docker 模块向 AI 注册的 MCP 工具（UiDelegated）。
 *
 * 与 `BUILTIN_TOOL_SPECS` 中 `omni_docker_*` 的 schema 一一对应。
 * 所有工具底层复用既有的 Tauri 命令：
 * - `docker_list_connections` / `docker_list_containers` /
 *   `docker_container_logs` / `docker_inspect_container` /
 *   `docker_container_action` / `docker_exec_command`
 *
 * 设计要点：
 * - `connection_id` 本地 Engine 固定为 'docker-local'；其他来源用
 *   `omni_docker_list_connections`（Native 工具）查询。
 * - container_id 既支持完整 id 也支持 name；后端 DockerAdapter 统一解析。
 * - exec 工具走非交互式 exec channel（tty=false），返回结构化
 *   `{stdout, stderr, exit_code}`，不会污染容器终端 UI。
 * - 危险动作（kill/remove）由后端在 audit log 中记录；前端审批流程
 *   走通用 UiDelegated 通道（与 ssh_exec 危险命令同机制）。
 */

/** 一次性 exec 的结构化输出（与 Rust `DockerExecOneShotOutput` 对齐）。
 *  待 tauri-specta 下次 regenerate 后可改为从 bindings 导入。 */
interface DockerExecOneShotOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DockerListContainersInvokeArgs {
  connectionId: string;
  filter: string | null;
}

interface DockerContainerLogsInvokeArgs {
  connectionId: string;
  containerId: string;
  tail: number;
  since: string | null;
}

interface DockerInspectContainerInvokeArgs {
  connectionId: string;
  containerId: string;
}

interface DockerContainerActionInvokeArgs {
  connectionId: string;
  containerId: string;
  action: string;
}

interface DockerExecCommandInvokeArgs {
  connectionId: string;
  containerId: string;
  command: string;
}

/** 容器列表精简视图（去掉大字段，便于 AI 阅读） */
interface DockerContainerAiSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  statusText: string;
  running: boolean;
  ports: string[];
  networks: string[];
  ipAddress: string | null;
  composeProject: string | null;
  composeService: string | null;
}

function toAiSummary(c: DockerContainerSummary): DockerContainerAiSummary {
  return {
    id: c.id,
    name: c.name,
    image: c.image,
    state: c.state,
    statusText: c.statusText,
    running: c.running,
    ports: c.ports.map((p) =>
      p.publicPort != null
        ? `${p.ip ?? "0.0.0.0"}:${p.publicPort}->${p.privatePort}/${p.protocol}`
        : `${p.privatePort}/${p.protocol}`,
    ),
    networks: c.networks,
    ipAddress: c.ipAddress,
    composeProject: c.composeProject ?? null,
    composeService: c.composeService ?? null,
  };
}

async function dockerListContainers(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const rawFilter = optionalString(args, "filter");
  if (rawFilter && !["all", "running", "stopped"].includes(rawFilter)) {
    throw new Error(`未知 filter：${rawFilter}（应为 all/running/stopped）`);
  }
  const containers = await invoke<DockerContainerSummary[]>("docker_list_containers", {
    connectionId: connection_id,
    filter: rawFilter ?? null,
  } satisfies DockerListContainersInvokeArgs);
  const simplified = containers.map(toAiSummary);
  return JSON.stringify(
    {
      connectionId: connection_id,
      filter: rawFilter ?? "all",
      count: simplified.length,
      containers: simplified,
    },
    null,
    2,
  );
}

async function dockerContainerLogs(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const container_id = requireString(args, "container_id");
  const tail_raw = args.tail;
  const tail =
    typeof tail_raw === "number" && Number.isFinite(tail_raw) && tail_raw > 0
      ? Math.floor(tail_raw)
      : 200;
  const since = optionalString(args, "since");
  const logs = await invoke<DockerLogLine[]>("docker_container_logs", {
    connectionId: connection_id,
    containerId: container_id,
    tail,
    since: since ?? null,
  } satisfies DockerContainerLogsInvokeArgs);
  return JSON.stringify(
    {
      connectionId: connection_id,
      containerId: container_id,
      tail,
      count: logs.length,
      logs,
    },
    null,
    2,
  );
}

async function dockerInspectContainer(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const container_id = requireString(args, "container_id");
  const detail = await invoke<DockerContainerDetail>("docker_inspect_container", {
    connectionId: connection_id,
    containerId: container_id,
  } satisfies DockerInspectContainerInvokeArgs);
  // 去掉 summary 重复字段，保留 detail 独有信息
  const simplified = {
    connectionId: connection_id,
    containerId: container_id,
    name: detail.summary.name,
    image: detail.summary.image,
    state: detail.summary.state,
    statusText: detail.summary.statusText,
    running: detail.summary.running,
    command: detail.command,
    restartPolicy: detail.restartPolicy,
    exitCode: detail.exitCode,
    env: detail.env,
    mounts: detail.mounts,
    networks: detail.networks,
  };
  return JSON.stringify(simplified, null, 2);
}

async function dockerContainerAction(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const container_id = requireString(args, "container_id");
  const action = requireString(args, "action");
  const validActions = ["start", "stop", "restart", "kill", "pause", "unpause", "remove"];
  if (!validActions.includes(action)) {
    throw new Error(`未知 action：${action}（应为 ${validActions.join("/")}）`);
  }
  await invoke<void>("docker_container_action", {
    connectionId: connection_id,
    containerId: container_id,
    action,
  } satisfies DockerContainerActionInvokeArgs);
  const isDestructive = action === "kill" || action === "remove";
  return JSON.stringify(
    {
      connectionId: connection_id,
      containerId: container_id,
      action,
      applied: true,
      note: isDestructive
        ? `已执行危险动作 ${action}；该操作已被 audit log 记录`
        : `容器 ${action} 操作已下发`,
    },
    null,
    2,
  );
}

async function dockerExec(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const container_id = requireString(args, "container_id");
  const command = requireString(args, "command");
  const output = await invoke<DockerExecOneShotOutput>("docker_exec_command", {
    connectionId: connection_id,
    containerId: container_id,
    command,
  } satisfies DockerExecCommandInvokeArgs);
  return JSON.stringify(
    {
      connectionId: connection_id,
      containerId: container_id,
      command,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
    },
    null,
    2,
  );
}

const connectionIdSchema = {
  type: "string",
  description:
    "Docker 连接 id；本地 Engine 用 'docker-local'，可先用 omni_docker_list_connections 查询",
};
const containerIdSchema = {
  type: "string",
  description: "容器 id 或名称",
};

/** Docker 模块 MCP 工具名（omni_{module}_{function_name}） */
export const DOCKER_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_docker_list_containers",
    description:
      "列出指定 Docker 连接下的容器（id/name/image/state/ports/networks）。\
filter 支持 all / running / stopped，默认 all。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        filter: {
          type: "string",
          enum: ["all", "running", "stopped"],
          description: "容器筛选，默认 all",
        },
      },
      required: ["connection_id"],
    },
    handler: dockerListContainers,
  },
  {
    name: "omni_docker_container_logs",
    description:
      "拉取容器最近日志（默认 tail=200），可选 since 时间范围（'all' / '15m' / '1h' / '24h' / RFC3339）。\
返回 {stream, message} 数组。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        container_id: containerIdSchema,
        tail: {
          type: "integer",
          description: "返回最后 N 行，默认 200",
        },
        since: {
          type: "string",
          description: "可选时间范围：'all' / 相对时长（'15m'、'1h'、'24h'）/ RFC3339",
        },
      },
      required: ["connection_id", "container_id"],
    },
    handler: dockerContainerLogs,
  },
  {
    name: "omni_docker_inspect_container",
    description:
      "查看容器详情（command/restart_policy/exit_code/env/mounts/networks 等）。\
仅 Local / Remote / SSH Engine 支持；1Panel 不支持。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        container_id: containerIdSchema,
      },
      required: ["connection_id", "container_id"],
    },
    handler: dockerInspectContainer,
  },
  {
    name: "omni_docker_container_action",
    description:
      "对容器执行生命周期动作（start/stop/restart/kill/pause/unpause/remove）。\
kill/remove 为危险动作，需用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        container_id: containerIdSchema,
        action: {
          type: "string",
          enum: ["start", "stop", "restart", "kill", "pause", "unpause", "remove"],
          description: "生命周期动作；kill/remove 为危险动作，需用户确认",
        },
      },
      required: ["connection_id", "container_id", "action"],
    },
    handler: dockerContainerAction,
  },
  {
    name: "omni_docker_exec",
    description:
      "在容器内执行非交互式命令（单条；不支持 ; / && / || 复合命令），返回 stdout/stderr/exit_code。\
1Panel 不支持此工具。如需复杂脚本，建议先 `cat > /tmp/x.sh <<EOF ... EOF` 再 `sh /tmp/x.sh`。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        container_id: containerIdSchema,
        command: {
          type: "string",
          description: "要在容器内执行的非交互命令（单条；不支持 ; / && / || 复合命令）",
        },
      },
      required: ["connection_id", "container_id", "command"],
    },
    handler: dockerExec,
  },
];

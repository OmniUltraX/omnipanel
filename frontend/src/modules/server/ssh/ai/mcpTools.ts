import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../../lib/ai/context";
import { optionalString, requireString } from "../../../../lib/ai/mcpToolArgs";
import { evaluateToolRisk } from "../../../../lib/ai/toolRisk";
import { useActionDraftStore } from "../../../../stores/actionDraftStore";
import type {
  HostSystemStats,
  SshExecOutput,
  SshTunnelInfo,
} from "../../../../ipc/bindings";

/**
 * SSH 模块向 AI 注册的 MCP 工具（UiDelegated）。
 *
 * 与 `BUILTIN_TOOL_SPECS` 中 `omni_ssh_*` 的 schema 一一对应。
 * 所有工具底层复用既有的 Tauri 命令（`ssh_pool_exec_command` /
 * `ssh_pool_fetch_stats` / `ssh_create_tunnel` / `ssh_list_tunnels`），
 * 不引入新的后端代码。
 *
 * 设计要点：
 * - `resource_id` / `connection_id` 都是 connections 表中的 SSH 连接 id；
 *   AI 可先调用 Native 工具 `omni_ssh_list_connections` 获取候选主机。
 * - exec 命令直接走连接池的 exec channel（非交互式 capture），与终端
 *   `omni_terminal_run_terminal_command` 走 PTY 不同：这里返回结构化
 *   `{stdout, stderr, exit_code}`，不会污染终端 UI。
 * - 危险命令的审批目前依赖后端 exec channel 的语义；后续若加危险命令
 *   拦截，可在 `ssh_pool_exec_command` 实现层统一加。
 */

interface SshExecInvokeArgs {
  resourceId: string;
  command: string;
}

async function sshExec(args: Record<string, unknown>): Promise<string> {
  const resource_id = requireString(args, "resource_id");
  const command = requireString(args, "command");

  // 风险评估：高风险命令走审批队列
  const risk = evaluateToolRisk("omni_ssh_exec", JSON.stringify(args), resource_id);
  if (risk.needsApproval) {
    const result = await useActionDraftStore.getState().enqueueAwaitable({
      kind: "ssh",
      title: `SSH 执行: ${command.slice(0, 80)}`,
      preview: `主机: ${resource_id}\n命令: ${command}\n风险: ${risk.risk}${risk.riskCheck?.matches.length ? `\n警告: ${risk.riskCheck.matches.map((m) => m.desc).join(", ")}` : ""}`,
      execute: async () => {
        const output = await invoke<SshExecOutput>("ssh_pool_exec_command", {
          resourceId: resource_id,
          command,
        } satisfies SshExecInvokeArgs);
        return JSON.stringify(
          {
            resourceId: resource_id,
            command,
            stdout: output.stdout,
            stderr: output.stderr,
            exitCode: output.exitCode,
          },
          null,
          2,
        );
      },
      risk: risk.risk,
      riskCheck: risk.riskCheck,
      environment: risk.environment,
      toolName: "omni_ssh_exec",
      resourceId: resource_id,
    });
    return result;
  }

  const output = await invoke<SshExecOutput>("ssh_pool_exec_command", {
    resourceId: resource_id,
    command,
  } satisfies SshExecInvokeArgs);
  return JSON.stringify(
    {
      resourceId: resource_id,
      command,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
    },
    null,
    2,
  );
}

interface SshGetStatsInvokeArgs {
  resourceId: string;
}

async function sshGetStats(args: Record<string, unknown>): Promise<string> {
  const resource_id = requireString(args, "resource_id");
  const stats = await invoke<HostSystemStats>("ssh_pool_fetch_stats", {
    resourceId: resource_id,
  } satisfies SshGetStatsInvokeArgs);
  return JSON.stringify(stats, null, 2);
}

async function sshListTunnels(): Promise<string> {
  const tunnels = await invoke<SshTunnelInfo[]>("ssh_list_tunnels");
  if (tunnels.length === 0) {
    return JSON.stringify({ tunnels: [], note: "当前没有 SSH 隧道" }, null, 2);
  }
  return JSON.stringify({ tunnels }, null, 2);
}

interface SshCreateTunnelInvokeArgs {
  connectionId: string;
  tunnelType: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

async function sshCreateTunnel(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const tunnel_type = requireString(args, "tunnel_type");
  if (!["local", "remote", "dynamic"].includes(tunnel_type)) {
    throw new Error(`未知隧道类型：${tunnel_type}（应为 local/remote/dynamic）`);
  }
  const local_port = args.local_port;
  if (typeof local_port !== "number" || !Number.isFinite(local_port)) {
    throw new Error("local_port 必须为数字");
  }
  if (local_port < 1 || local_port > 65535) {
    throw new Error(`local_port 越界：${local_port}`);
  }
  const remote_host = optionalString(args, "remote_host");
  const remote_port = args.remote_port;
  if (tunnel_type !== "dynamic") {
    if (!remote_host) {
      throw new Error(`${tunnel_type} 隧道必须提供 remote_host`);
    }
    if (typeof remote_port !== "number" || !Number.isFinite(remote_port)) {
      throw new Error(`${tunnel_type} 隧道必须提供 remote_port（数字）`);
    }
    if (remote_port < 1 || remote_port > 65535) {
      throw new Error(`remote_port 越界：${remote_port}`);
    }
  }
  const info = await invoke<SshTunnelInfo>("ssh_create_tunnel", {
    connectionId: connection_id,
    tunnelType: tunnel_type,
    localPort: local_port,
    remoteHost: remote_host ?? "",
    remotePort: typeof remote_port === "number" ? remote_port : 0,
  } satisfies SshCreateTunnelInvokeArgs);
  return JSON.stringify(
    {
      created: true,
      tunnel: info,
      note:
        tunnel_type === "dynamic"
          ? `SOCKS 代理已建立，本地端口 ${local_port} 可作为代理使用`
          : `隧道已建立，访问 127.0.0.1:${local_port} 等价于访问 ${remote_host}:${remote_port}`,
    },
    null,
    2,
  );
}

const resourceIdSchema = {
  type: "string",
  description: "SSH 主机连接 id（可先用 omni_ssh_list_connections 查询）",
};

/** SSH 模块 MCP 工具名（omni_{module}_{function_name}） */
export const SSH_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_ssh_exec",
    description:
      "在指定 SSH 主机上非交互式执行 shell 命令，返回 stdout/stderr/exit_code。\
不支持 TUI/流式命令（top/vim/tail -f），请用 top -bn1 | head / tail -n 100 等替代。\
危险命令会进入用户确认流程。",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: resourceIdSchema,
        command: {
          type: "string",
          description: "要在远程主机上执行的非交互式 shell 命令",
        },
      },
      required: ["resource_id", "command"],
    },
    handler: sshExec,
  },
  {
    name: "omni_ssh_get_stats",
    description:
      "拉取指定 SSH 主机的实时系统指标快照（CPU/内存/磁盘/网络/负载/运行时长/OS 信息）。",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: resourceIdSchema,
      },
      required: ["resource_id"],
    },
    handler: sshGetStats,
  },
  {
    name: "omni_ssh_list_tunnels",
    description: "列出当前所有 SSH 隧道（端口转发）及其状态。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: sshListTunnels,
  },
  {
    name: "omni_ssh_create_tunnel",
    description:
      "在指定 SSH 连接上创建端口转发隧道。local=本地端口转发到远程；\
remote=远程端口转发到本地；dynamic=SOCKS 动态代理（可省略 remote_host/remote_port）。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: {
          type: "string",
          description: "SSH 主机连接 id（可先用 omni_ssh_list_connections 查询）",
        },
        tunnel_type: {
          type: "string",
          enum: ["local", "remote", "dynamic"],
          description:
            "local=本地端口转发到远程；remote=远程端口转发到本地；dynamic=SOCKS 动态代理",
        },
        local_port: {
          type: "integer",
          description: "本地监听端口（1-65535）",
        },
        remote_host: {
          type: "string",
          description: "目标主机（dynamic 类型可省略）",
        },
        remote_port: {
          type: "integer",
          description: "目标端口（dynamic 类型可省略）",
        },
      },
      required: ["connection_id", "tunnel_type", "local_port"],
    },
    handler: sshCreateTunnel,
  },
];

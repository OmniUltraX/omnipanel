import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../../lib/ai/context";
import { optionalString, requireString } from "../../../../lib/ai/mcpToolArgs";
import { redactSecretsInText } from "../../../../lib/ai/redactSecrets";
import { runWithToolGate } from "../../../../lib/ai/toolGate";
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
 * - exec 命令直接走连接池的 exec channel（非交互式 capture），返回结构化
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

  const run = async () => {
    const output = await invoke<SshExecOutput>("ssh_pool_exec_command", {
      resourceId: resource_id,
      command,
    } satisfies SshExecInvokeArgs);
    return redactSecretsInText(
      JSON.stringify(
        {
          resourceId: resource_id,
          command,
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
        },
        null,
        2,
      ),
    );
  };

  return runWithToolGate(
    {
      toolName: "omni_ssh_exec",
      args,
      resourceId: resource_id,
      channel: "ui-delegated",
    },
    run,
  );
}

interface SshCreateRunScriptInvokeArgs {
  resourceId: string;
  name: string;
  content: string;
  args?: string[];
  timeoutSecs?: number;
}

interface SshCreateRunScriptOutput {
  remotePath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function optionalStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`参数 ${key} 必须是字符串数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`参数 ${key}[${index}] 必须是字符串`);
    }
    return item;
  });
}

function optionalPositiveInt(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`参数 ${key} 必须是正数`);
  }
  return Math.floor(value);
}

async function sshCreateRunScript(args: Record<string, unknown>): Promise<string> {
  const resource_id = requireString(args, "resource_id");
  const name = requireString(args, "name");
  if (typeof args.content !== "string") {
    throw new Error("缺少必填参数：content");
  }
  const content = args.content;
  const scriptArgs = optionalStringList(args, "args");
  const timeoutSecs = optionalPositiveInt(args, "timeout_secs");

  const run = async () => {
    const output = await invoke<SshCreateRunScriptOutput>("ssh_pool_create_run_script", {
      resourceId: resource_id,
      name,
      content,
      args: scriptArgs,
      timeoutSecs,
    } satisfies SshCreateRunScriptInvokeArgs);
    return redactSecretsInText(
      JSON.stringify(
        {
          resourceId: resource_id,
          name,
          remotePath: output.remotePath,
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
        },
        null,
        2,
      ),
    );
  };

  return runWithToolGate(
    {
      toolName: "omni_ssh_create_run_script",
      args,
      resourceId: resource_id,
      channel: "ui-delegated",
    },
    run,
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
      "在当前绑定的终端会话执行命令（本地 PowerShell/CMD/bash 或 SSH 均可），返回输出。\
终端内联场景可不传 resource_id。不支持 TUI/流式（top/vim/tail -f）；危险命令需确认。\
查时间/文件/进程等实时事实必须调用本工具，禁止凭记忆编造。",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: {
          type: "string",
          description:
            "可选；SSH 连接 id。终端内联已绑定会话时可省略；侧栏/多主机场景再传",
        },
        command: {
          type: "string",
          description:
            "要在当前终端会话执行的非交互式命令（语法须匹配该会话 shell：PowerShell 用 Get-Date 等）",
        },
      },
      required: ["command"],
    },
    handler: sshExec,
  },
  {
    name: "omni_ssh_create_run_script",
    description:
      "在指定 SSH 主机上创建脚本并立即执行：写入 ~/.omnipanel/scripts/<name>（同名覆盖），\
chmod +x 后以 bash 运行。适合多行脚本或需落盘复用；简单一行命令优先用 omni_ssh_exec。",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: resourceIdSchema,
        name: {
          type: "string",
          description:
            "脚本文件名（仅字母/数字/点/下划线/连字符）；写入 ~/.omnipanel/scripts/",
        },
        content: {
          type: "string",
          description: "脚本正文（建议自带 shebang）",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "可选；传给脚本的参数",
        },
        timeout_secs: {
          type: "integer",
          description: "可选；超时秒数，默认 120，最大 600",
        },
      },
      required: ["resource_id", "name", "content"],
    },
    handler: sshCreateRunScript,
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

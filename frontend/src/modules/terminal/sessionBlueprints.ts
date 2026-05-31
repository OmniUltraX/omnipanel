import type { WorkspaceResource } from "../../lib/resourceRegistry";
import type { TerminalPane } from "../../stores/terminalStore";

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

export function getBlueprint(
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

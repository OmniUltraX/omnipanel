import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import type { HostProfile } from "../types";

export const HOST_PROFILES: Record<string, HostProfile> = {
  "prod-web-01": {
    os: "Ubuntu 22.04",
    uptime: "142 天",
    connected: "已连接 3 天 14 小时",
    username: "deploy",
    authMethod: "SSH Key",
    keyFile: "~/.ssh/id_ed25519_prod",
    keyScope: "prod-web-01 / prod-web-02",
    cpu: "23%",
    memory: "6.2 / 16 GB",
    disk: "47%",
    network: "12 MB/s",
    tags: ["web", "nginx", "docker", "frontend"],
    recentActivity: [
      { time: "09:14:02", command: "docker ps", status: "ok" },
      { time: "09:12:01", command: "curl localhost:8080/health", status: "ok" },
      { time: "09:10:45", command: "docker logs nginx-proxy --tail 50", status: "ok" },
      { time: "09:08:33", command: "systemctl restart nginx", status: "warn" },
      { time: "08:55:12", command: "apt update && apt upgrade -y", status: "ok" },
    ],
    files: [
      { name: "deploy.sh", type: "Shell Script", size: "4.3 KB", modified: "今天 09:12" },
      { name: "docker-compose.yml", type: "YAML", size: "2.1 KB", modified: "昨天 17:42" },
      { name: "nginx.conf", type: "Config", size: "1.2 KB", modified: "昨天 16:20" },
      { name: "logs/", type: "Directory", size: "—", modified: "昨天 10:04" },
    ],
    tunnels: [
      { local: "localhost:5432", remote: "prod-db-master:5432", status: "Active" },
      { local: "localhost:6379", remote: "prod-redis:6379", status: "Idle" },
    ],
    presets: [
      {
        id: "ops",
        title: "排障会话",
        desc: "快速查看容器、日志与健康检查，适合现场问题定位。",
        purpose: "Incident Triage",
        commands: [
          "docker ps",
          "docker logs nginx-proxy --tail 50",
          "curl -s localhost:8080/health | jq .",
        ],
        tone: "accent",
      },
      {
        id: "deploy",
        title: "发布校验",
        desc: "切入部署后的检查路径，确认版本、服务与入口状态。",
        purpose: "Release Validation",
        commands: [
          "git rev-parse --short HEAD",
          "docker compose ps",
          "systemctl status nginx --no-pager",
        ],
        tone: "warn",
      },
      {
        id: "maint",
        title: "维护窗口",
        desc: "用于证书更新、日志归档与低风险维护操作。",
        purpose: "Maintenance",
        commands: [
          "sudo certbot renew --dry-run",
          "du -sh /var/log",
          "sudo logrotate -vf /etc/logrotate.conf",
        ],
        tone: "success",
      },
    ],
    relatedModules: [
      {
        label: "Docker 容器",
        desc: "联动当前主机容器视图",
        path: "/docker",
        resourceId: "docker-prod-web",
      },
      { label: "Workflow 发布", desc: "跳转部署 / 巡检工作流", path: "/workflow" },
      { label: "终端工作区", desc: "进入统一终端与 AI 协同界面", path: "/terminal" },
    ],
    notes: [
      "建议把生产 SSH 作为工作台入口，而不是单次连接。",
      "命令包、Tunnel、SFTP 与 Workflow 要围绕同一主机上下文协同。",
    ],
  },
  "prod-web-02": {
    os: "Ubuntu 22.04",
    uptime: "128 天",
    connected: "已连接 1 天 8 小时",
    username: "deploy",
    authMethod: "SSH Key",
    keyFile: "~/.ssh/id_ed25519_prod",
    keyScope: "canary / prod",
    cpu: "18%",
    memory: "4.8 / 16 GB",
    disk: "42%",
    network: "8 MB/s",
    tags: ["web", "canary", "docker"],
    recentActivity: [
      { time: "10:04:11", command: "docker compose ps", status: "ok" },
      { time: "09:56:20", command: "journalctl -u nginx -n 50", status: "ok" },
      { time: "09:44:01", command: "systemctl reload nginx", status: "ok" },
    ],
    files: [
      { name: "release-notes.txt", type: "Text", size: "0.8 KB", modified: "今天 10:01" },
      { name: "app.env", type: "Env", size: "0.5 KB", modified: "昨天 22:13" },
    ],
    tunnels: [{ local: "localhost:8081", remote: "127.0.0.1:8080", status: "Active" }],
    presets: [
      {
        id: "canary",
        title: "灰度验证",
        desc: "面向 canary 节点的发布验证与入口比对。",
        purpose: "Canary Verification",
        commands: [
          "docker compose ps",
          "curl -I https://canary.example.com",
          "journalctl -u nginx -n 50 --no-pager",
        ],
        tone: "accent",
      },
      {
        id: "rollback",
        title: "回滚演练",
        desc: "预置回滚前的对比检查路径与关键命令。",
        purpose: "Rollback Drill",
        commands: [
          "git rev-parse --short HEAD",
          "docker image ls | head",
          "systemctl reload nginx",
        ],
        tone: "warn",
      },
    ],
    relatedModules: [
      { label: "终端工作区", desc: "进入会话编排中心", path: "/terminal" },
      { label: "Workflow 发布", desc: "查看发布链路与历史", path: "/workflow" },
    ],
    notes: ["prod-web-02 更适合承载灰度与验证场景。"],
  },
  "staging-bastion": {
    os: "Ubuntu 22.04",
    uptime: "64 天",
    connected: "已连接 6 小时",
    username: "ops",
    authMethod: "SSH Key",
    keyFile: "~/.ssh/staging_ed25519",
    keyScope: "staging cluster / bastion",
    cpu: "31%",
    memory: "3.4 / 8 GB",
    disk: "31%",
    network: "3 MB/s",
    tags: ["api", "staging", "audit"],
    recentActivity: [
      { time: "09:42:14", command: "htop", status: "ok" },
      { time: "09:32:03", command: "tail -f /var/log/syslog", status: "ok" },
      { time: "09:22:48", command: "ssh deploy@staging-api.internal", status: "warn" },
    ],
    files: [
      { name: "audit.log", type: "Log", size: "2.8 MB", modified: "今天 09:41" },
      { name: "ssh_config", type: "Config", size: "0.4 KB", modified: "昨天 18:14" },
    ],
    tunnels: [{ local: "localhost:9000", remote: "127.0.0.1:9000", status: "Idle" }],
    presets: [
      {
        id: "bastion",
        title: "中转会话",
        desc: "把堡垒机当作多主机入口，整理后续跳转动作。",
        purpose: "Bastion Routing",
        commands: [
          "ssh deploy@staging-api.internal",
          "docker ps",
          "journalctl -u ml-worker -n 50 --no-pager",
        ],
        tone: "accent",
      },
      {
        id: "audit",
        title: "审计巡检",
        desc: "结合日志与命令历史，对预发链路做审计核对。",
        purpose: "Audit Review",
        commands: [
          "tail -f /var/log/auth.log",
          "last | head",
          'grep -n "Failed" /var/log/auth.log | tail',
        ],
        tone: "warn",
      },
    ],
    relatedModules: [
      {
        label: "Server 监控",
        desc: "查看 staging API 状态",
        path: "/server",
        resourceId: "staging-api",
      },
      { label: "Workflow 巡检", desc: "进入巡检 / 历史记录", path: "/workflow" },
      { label: "终端工作区", desc: "打开中转会话工作台", path: "/terminal" },
    ],
    notes: ["堡垒机的价值在于串联多主机路径、审计信息与后续动作。"],
  },
  default: {
    os: "Ubuntu 22.04",
    uptime: "64 天",
    connected: "已连接 6 小时",
    username: "deploy",
    authMethod: "SSH Key",
    keyFile: "~/.ssh/id_ed25519",
    keyScope: "default scope",
    cpu: "12%",
    memory: "2.4 / 8 GB",
    disk: "31%",
    network: "3 MB/s",
    tags: ["api", "staging"],
    recentActivity: [
      { time: "09:42:14", command: "htop", status: "ok" },
      { time: "09:32:03", command: "tail -f /var/log/syslog", status: "ok" },
    ],
    files: [
      { name: "app/", type: "Directory", size: "—", modified: "今天 09:30" },
      { name: "service.env", type: "Env", size: "0.3 KB", modified: "昨天 18:14" },
    ],
    tunnels: [{ local: "localhost:9000", remote: "127.0.0.1:9000", status: "Idle" }],
    presets: [
      {
        id: "default",
        title: "标准会话",
        desc: "保留统一 SSH 上下文的标准终端会话。",
        purpose: "SSH Workbench",
        commands: ["pwd", "ls -la", "htop"],
        tone: "accent",
      },
    ],
    relatedModules: [{ label: "终端工作区", desc: "进入统一终端", path: "/terminal" }],
    notes: ["SSH 模块应该承担连接、命令包、SFTP、Tunnel 与联动入口的职责。"],
  },
};

export function getProfile(resource: WorkspaceResource | null): HostProfile {
  if (!resource) return HOST_PROFILES.default;
  return HOST_PROFILES[resource.id] ?? HOST_PROFILES.default;
}

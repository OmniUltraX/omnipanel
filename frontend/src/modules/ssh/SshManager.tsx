import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HostListPanel } from "../../components/workspace/HostListPanel";
import { type WorkspaceResource } from "../../lib/resourceRegistry";
import { useWorkspaceResources } from "../../stores/connectionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

type ModuleTab = "hosts" | "tunnels" | "keys";
type DetailTab = "overview" | "terminal" | "sftp" | "tunnels" | "monitoring";
type LaunchPreset = {
  id: string;
  title: string;
  desc: string;
  purpose: string;
  commands: string[];
  tone: "accent" | "success" | "warn";
};

const MODULE_TABS: ModuleTab[] = ["hosts", "tunnels", "keys"];
const DETAIL_TABS: DetailTab[] = ["overview", "terminal", "sftp", "tunnels", "monitoring"];

const HOST_PROFILES: Record<string, {
  os: string;
  uptime: string;
  connected: string;
  username: string;
  authMethod: string;
  keyFile: string;
  keyScope: string;
  cpu: string;
  memory: string;
  disk: string;
  network: string;
  tags: string[];
  recentActivity: Array<{ time: string; command: string; status: "ok" | "warn" }>;
  files: Array<{ name: string; type: string; size: string; modified: string }>;
  tunnels: Array<{ local: string; remote: string; status: string }>;
  presets: LaunchPreset[];
  relatedModules: Array<{ label: string; desc: string; path: string; resourceId?: string }>;
  notes: string[];
}> = {
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
        commands: ["docker ps", "docker logs nginx-proxy --tail 50", "curl -s localhost:8080/health | jq ."],
        tone: "accent",
      },
      {
        id: "deploy",
        title: "发布校验",
        desc: "切入部署后的检查路径，确认版本、服务与入口状态。",
        purpose: "Release Validation",
        commands: ["git rev-parse --short HEAD", "docker compose ps", "systemctl status nginx --no-pager"],
        tone: "warn",
      },
      {
        id: "maint",
        title: "维护窗口",
        desc: "用于证书更新、日志归档与低风险维护操作。",
        purpose: "Maintenance",
        commands: ["sudo certbot renew --dry-run", "du -sh /var/log", "sudo logrotate -vf /etc/logrotate.conf"],
        tone: "success",
      },
    ],
    relatedModules: [
      { label: "Docker 容器", desc: "联动当前主机容器视图", path: "/docker", resourceId: "docker-prod-web" },
      { label: "Workflow 发布", desc: "跳转部署 / 巡检工作流", path: "/workflow" },
      { label: "终端工作区", desc: "进入统一终端与 AI 协同界面", path: "/terminal" },
    ],
    notes: ["建议把生产 SSH 作为工作台入口，而不是单次连接。", "命令包、Tunnel、SFTP 与 Workflow 要围绕同一主机上下文协同。"],
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
        commands: ["docker compose ps", "curl -I https://canary.example.com", "journalctl -u nginx -n 50 --no-pager"],
        tone: "accent",
      },
      {
        id: "rollback",
        title: "回滚演练",
        desc: "预置回滚前的对比检查路径与关键命令。",
        purpose: "Rollback Drill",
        commands: ["git rev-parse --short HEAD", "docker image ls | head", "systemctl reload nginx"],
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
        commands: ["ssh deploy@staging-api.internal", "docker ps", "journalctl -u ml-worker -n 50 --no-pager"],
        tone: "accent",
      },
      {
        id: "audit",
        title: "审计巡检",
        desc: "结合日志与命令历史，对预发链路做审计核对。",
        purpose: "Audit Review",
        commands: ["tail -f /var/log/auth.log", "last | head", "grep -n \"Failed\" /var/log/auth.log | tail"],
        tone: "warn",
      },
    ],
    relatedModules: [
      { label: "Server 监控", desc: "查看 staging API 状态", path: "/server", resourceId: "staging-api" },
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

const SSH_KEYS = [
  { name: "id_ed25519", meta: "ED25519 · Added 2025-12-01", usage: "Production hosts" },
  { name: "deploy_rsa", meta: "RSA 4096 · Added 2024-08-15", usage: "Legacy bastion" },
  { name: "staging_ed25519", meta: "ED25519 · Added 2026-03-12", usage: "Staging cluster" },
];

function getProfile(resource: WorkspaceResource | null) {
  if (!resource) return HOST_PROFILES.default;
  return HOST_PROFILES[resource.id] ?? HOST_PROFILES.default;
}

function envBadgeClass(resource: WorkspaceResource | null) {
  if (resource?.environment === "prod") return "badge badge-danger";
  if (resource?.environment === "staging") return "badge badge-warn";
  if (resource?.environment === "dev") return "badge badge-success";
  return "badge badge-muted";
}

function presetBadgeClass(tone: LaunchPreset["tone"]) {
  if (tone === "warn") return "badge badge-warn";
  if (tone === "success") return "badge badge-success";
  return "badge badge-accent";
}

const SSH_PATH = "/ssh";

export function SshManager() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const getResourceForPath = useWorkspaceStore((s) => s.getResourceForPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const addTerminalTab = useTerminalStore((s) => s.addTab);
  const setTerminalTab = useTerminalStore((s) => s.setActiveTab);
  const terminalTabs = useTerminalStore((s) => s.tabs);

  const [moduleTab, setModuleTab] = useState<ModuleTab>("hosts");
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");

  const allResources = useWorkspaceResources();
  const sshResources = useMemo(() => allResources.filter((resource) => resource.type === "ssh"), [allResources]);
  const resolvedSsh = getResourceForPath(SSH_PATH);
  const activeResource = resolvedSsh?.type === "ssh" ? resolvedSsh : sshResources[0] ?? null;
  const profile = getProfile(activeResource);
  const onlineHosts = useMemo(() => sshResources.filter((resource) => resource.status !== "offline").length, [sshResources]);
  const offlineHosts = useMemo(() => sshResources.filter((resource) => resource.status === "offline").length, [sshResources]);
  const hostAddress = activeResource?.subtitle?.split("@").at(-1) ?? "10.0.1.10:22";
  const hostName = activeResource?.name ?? "prod-web-01";
  const activeTunnelCount = profile.tunnels.filter((tunnel) => tunnel.status === "Active").length;
  const idleTunnelCount = profile.tunnels.length - activeTunnelCount;
  const warnActivityCount = profile.recentActivity.filter((item) => item.status === "warn").length;
  const keyCoverage = SSH_KEYS.filter((key) => profile.keyFile.includes(key.name.replace(/^.*\//, "")) || key.usage.toLowerCase().includes(profile.username.toLowerCase())).length || 1;

  const recommendedCommands = useMemo(
    () =>
      Array.from(new Set([...profile.presets.flatMap((preset) => preset.commands), ...profile.recentActivity.map((item) => item.command)])).slice(0, 6),
    [profile]
  );

  const operationalChecklist = useMemo(
    () => [
      `先确认 ${hostName} 当前状态与最近 ${profile.recentActivity.length} 条操作记录。`,
      `优先从 ${profile.presets[0]?.title ?? "标准会话"} 进入终端工作区，减少重复跳转。`,
      activeTunnelCount > 0 ? `已有 ${activeTunnelCount} 条活动 Tunnel，可直接串联数据库或内部服务调试。` : "当前没有活动 Tunnel，需要时先建立最小必要转发。",
      warnActivityCount > 0 ? `最近存在 ${warnActivityCount} 条风险动作，完成处理后记得回写工作流与巡检记录。` : "最近操作稳定，可继续做发布验证或维护动作。",
    ],
    [activeTunnelCount, hostName, profile, warnActivityCount]
  );

  const hostSignals = useMemo(
    () => [
      {
        title: activeResource?.status === "warning" ? "主机状态需要关注" : "主机状态稳定",
        desc:
          activeResource?.status === "warning"
            ? "当前资源被标记为 Warning，适合先走监控与日志排查流程。"
            : "当前主机在线且可用，适合直接进入会话预设或文件巡检。",
      },
      {
        title: "连接闭环",
        desc: `${profile.authMethod} · ${profile.keyScope}，建议把连接信息、命令包与后续模块跳转统一到同一主机上下文。`,
      },
      {
        title: "工作流协同",
        desc: profile.notes[0] ?? "SSH 页面应该承担连接、命令包、SFTP、Tunnel 与联动入口的职责。",
      },
    ],
    [activeResource?.status, profile]
  );

  const topbarTabs = useMemo(
    () =>
      MODULE_TABS.map((tab) => ({
        id: tab,
        label: t(`ssh.tabs.${tab}`),
        active: moduleTab === tab,
      })),
    [moduleTab, t]
  );

  useTopbarTabs(topbarTabs, { onSelect: (id) => setModuleTab(id as ModuleTab) }, { mode: "segment" });

  useEffect(() => {
    if (!useWorkspaceStore.getState().selectedResourceByPath[SSH_PATH] && sshResources[0]) {
      selectResource(sshResources[0].id, SSH_PATH);
    }
  }, [sshResources, selectResource]);

  useEffect(() => {
    setDetailTab("overview");
  }, [activeResource?.id]);

  const queueSshAction = useCallback(
    (title: string, description: string, command?: string) => {
      if (!activeResource) return;
      enqueueAction({
        type: "ssh",
        title,
        description: `${activeResource.name} · ${description}`,
        command,
        resourceId: activeResource.id,
        source: "用户",
      });
    },
    [activeResource, enqueueAction]
  );

  const openModule = useCallback(
    (path: string, resourceId?: string) => {
      if (resourceId) {
        selectResource(resourceId, path);
      }
      setActivePath(path);
      navigate(path);
    },
    [navigate, selectResource, setActivePath]
  );

  const openTerminal = useCallback(
    (preset?: LaunchPreset, forceNew = false) => {
      if (!activeResource) return;
      const purpose = preset?.purpose ?? "SSH Workbench";
      const existing = terminalTabs.find((tab) => {
        const activePane = tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
        return activePane?.resourceId === activeResource.id && activePane.purpose === purpose;
      });

      queueSshAction(preset ? preset.title : t("ssh.actions.openSession"), preset?.desc ?? "打开远程会话工作台", preset?.commands[0] ?? "ssh connect");

      if (existing && !forceNew) {
        setTerminalTab(existing.id);
      } else {
        const tabId = `ssh-${activeResource.id}-${Date.now()}`;
        addTerminalTab({
          id: tabId,
          title: `${activeResource.name} · ${preset?.title ?? "SSH"}`,
          type: "remote",
          resourceId: activeResource.id,
          shellLabel: "SSH",
          cwd: "~/",
          purpose,
          commandPack: preset?.commands ?? [],
        });
        setTerminalTab(tabId);
      }

      setActivePath("/terminal");
      navigate("/terminal");
    },
    [activeResource, addTerminalTab, navigate, queueSshAction, setActivePath, setTerminalTab, t, terminalTabs]
  );

  const runRecommendedCommand = useCallback(
    (command: string) => {
      openTerminal(
        {
          id: `quick-${command}`,
          title: "即时命令",
          desc: `从 SSH 页面直接发起命令：${command}`,
          purpose: "Quick Command",
          commands: [command],
          tone: "accent",
        },
        false
      );
    },
    [openTerminal]
  );

  const triggerFileAction = useCallback(
    (title: string, description: string, command?: string) => {
      queueSshAction(title, description, command);
    },
    [queueSshAction]
  );

  const triggerTunnelAction = useCallback(
    (title: string, description: string, command?: string) => {
      queueSshAction(title, description, command);
    },
    [queueSshAction]
  );

  const triggerKeyAction = useCallback(
    (title: string, description: string, command?: string) => {
      queueSshAction(title, description, command);
    },
    [queueSshAction]
  );

  const hostOverview = (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">{hostName}</div>
          <div className="host-addr-detail">
            {profile.username}@{hostAddress} · {profile.os} · {profile.connected}
          </div>
        </div>
        <span className={`badge ${activeResource?.status === "offline" ? "badge-muted" : activeResource?.status === "warning" ? "badge-warn" : "badge-success"}`} style={{ marginLeft: "auto" }}>
          {activeResource?.status === "offline" ? "Offline" : activeResource?.status === "warning" ? "Warning" : "Online"}
        </span>
        <span className={envBadgeClass(activeResource)}>{t(`env.${activeResource?.environment ?? "unknown"}`)}</span>
      </div>

      <div className="ssh-detail-tabs">
        {DETAIL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`ssh-detail-tab${detailTab === tab ? " active" : ""}`}
            onClick={() => setDetailTab(tab)}
          >
            {t(`ssh.detailTabs.${tab}`)}
          </button>
        ))}
      </div>

      <div className="ssh-detail-body">
        {detailTab === "overview" && (
          <>
            <div className="quick-stats">
              <div className="quick-stat">
                <div className="stat-label">CPU</div>
                <div className="stat-value">{profile.cpu}</div>
              </div>
              <div className="quick-stat">
                <div className="stat-label">Memory</div>
                <div className="stat-value">{profile.memory}</div>
              </div>
              <div className="quick-stat">
                <div className="stat-label">Tunnel</div>
                <div className="stat-value">{activeTunnelCount}</div>
              </div>
              <div className="quick-stat">
                <div className="stat-label">Uptime</div>
                <div className="stat-value">{profile.uptime}</div>
              </div>
            </div>

            <div className="ssh-workbench-grid">
              <div className="panel">
                <div className="panel-header">
                  <h3>连接详情</h3>
                  <span className="badge badge-muted">{profile.authMethod}</span>
                </div>
                <div className="panel-body">
                  <div className="form-grid">
                    <div className="form-field">
                      <label className="form-label">Host</label>
                      <input className="input" value={hostAddress.split(":")[0]} readOnly />
                    </div>
                    <div className="form-field">
                      <label className="form-label">Port</label>
                      <input className="input" value={hostAddress.split(":").at(-1) ?? "22"} readOnly />
                    </div>
                    <div className="form-field">
                      <label className="form-label">Username</label>
                      <input className="input" value={profile.username} readOnly />
                    </div>
                    <div className="form-field">
                      <label className="form-label">Key File</label>
                      <input className="input" value={profile.keyFile} readOnly />
                    </div>
                    <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                      <label className="form-label">Key Scope</label>
                      <input className="input" value={profile.keyScope} readOnly />
                    </div>
                    <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                      <label className="form-label">Tags</label>
                      <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                        {profile.tags.map((tag) => (
                          <span key={tag} className="tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="conn-actions">
                    <button className="btn btn-primary" onClick={() => openTerminal()}>
                      打开终端工作区
                    </button>
                    <button className="btn btn-secondary" onClick={() => setDetailTab("sftp")}>
                      浏览文件
                    </button>
                    <button className="btn btn-secondary" onClick={() => setDetailTab("tunnels")}>
                      管理 Tunnel
                    </button>
                    <button
                      className="btn btn-ghost text-danger"
                      style={{ marginLeft: "auto" }}
                      onClick={() => triggerTunnelAction("断开 SSH 会话", "准备断开当前主机连接并回收会话上下文", "exit")}
                    >
                      断开连接
                    </button>
                  </div>
                </div>
              </div>

              <div className="ssh-side-stack">
                <div className="panel">
                  <div className="panel-header">
                    <h3>会话预设</h3>
                    <span className="badge badge-accent">SSH + Terminal</span>
                  </div>
                  <div className="panel-body ssh-session-grid">
                    {profile.presets.map((preset) => (
                      <button key={preset.id} type="button" className="ssh-launch-card" onClick={() => openTerminal(preset)}>
                        <div className="ssh-launch-head">
                          <span>{preset.title}</span>
                          <span className={presetBadgeClass(preset.tone)}>{preset.purpose}</span>
                        </div>
                        <div className="ssh-launch-desc">{preset.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <h3>操作闭环</h3>
                  </div>
                  <div className="panel-body action-list">
                    {operationalChecklist.map((item) => (
                      <div key={item} className="action-row">
                        <span className="action-title">下一步</span>
                        <span className="action-meta">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <h3>关联模块</h3>
                  </div>
                  <div className="panel-body ssh-module-list">
                    {profile.relatedModules.map((item) => (
                      <button key={`${item.path}-${item.label}`} type="button" className="ssh-module-item" onClick={() => openModule(item.path, item.resourceId)}>
                        <span className="action-title">{item.label}</span>
                        <span className="action-meta">{item.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="info-grid" style={{ marginTop: "var(--sp-4)" }}>
              <div className="panel">
                <div className="panel-header">
                  <h3>最近操作</h3>
                </div>
                <div className="panel-body">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Command</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.recentActivity.map((item) => (
                        <tr key={`${item.time}-${item.command}`}>
                          <td className="text-muted">{item.time}</td>
                          <td>{item.command}</td>
                          <td>
                            <span className={`badge ${item.status === "ok" ? "badge-success" : "badge-warn"}`}>
                              {item.status === "ok" ? "OK" : "Warn"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <h3>主机画像</h3>
                  <span className={`badge ${warnActivityCount > 0 ? "badge-warn" : "badge-success"}`}>{warnActivityCount > 0 ? "需关注" : "稳定"}</span>
                </div>
                <div className="panel-body action-list">
                  {hostSignals.map((signal) => (
                    <div key={signal.title} className="action-row">
                      <span className="action-title">{signal.title}</span>
                      <span className="action-meta">{signal.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {detailTab === "terminal" && (
          <div className="ssh-workbench-grid">
            <div className="panel">
              <div className="panel-header">
                <h3>远程会话预览</h3>
                <button className="btn btn-primary btn-sm" onClick={() => openTerminal()}>
                  打开终端工作区
                </button>
              </div>
              <div className="terminal-area" style={{ minHeight: 320 }}>
                <div className="terminal-line">
                  <span className="terminal-prompt">{profile.username}@{hostName}:~$</span> <span className="terminal-cmd">docker ps</span>
                </div>
                <div className="terminal-line terminal-output">CONTAINER ID   IMAGE                STATUS       PORTS</div>
                <div className="terminal-line terminal-output">a3f8c2d1e5b9   nginx:1.25-alpine    Up 3 days    0.0.0.0:80-&gt;80/tcp</div>
                <div className="terminal-line terminal-output">bd91f773aa10   app/api:2.1.0        Up 3 days    0.0.0.0:8080-&gt;8080/tcp</div>
                <div className="terminal-line" style={{ marginTop: 8 }}>
                  <span className="text-accent">SSH 页面只负责组织会话，上线操作统一进入终端工作区执行与留痕。</span>
                </div>
              </div>
            </div>

            <div className="ssh-side-stack">
              <div className="panel">
                <div className="panel-header">
                  <h3>新建会话</h3>
                </div>
                <div className="panel-body ssh-session-grid">
                  {profile.presets.map((preset) => (
                    <button key={preset.id} type="button" className="ssh-launch-card" onClick={() => openTerminal(preset, true)}>
                      <div className="ssh-launch-head">
                        <span>{preset.title}</span>
                        <span className={presetBadgeClass(preset.tone)}>New</span>
                      </div>
                      <div className="ssh-launch-desc">{preset.commands.join(" · ")}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <h3>推荐命令</h3>
                </div>
                <div className="panel-body term-command-pack">
                  {recommendedCommands.map((command) => (
                    <button key={command} type="button" className="term-command-chip" onClick={() => runRecommendedCommand(command)}>
                      {command}
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <h3>模块说明</h3>
                </div>
                <div className="panel-body action-list">
                  {profile.notes.map((note) => (
                    <div key={note} className="action-row">
                      <span className="action-title">SSH 价值</span>
                      <span className="action-meta">{note}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {detailTab === "sftp" && (
          <div className="ssh-workbench-grid">
            <div>
              <div className="sftp-toolbar">
                <button className="btn btn-secondary btn-sm" onClick={() => triggerFileAction("上传文件到主机", "通过 SFTP 上传当前运维文件", "scp ./local-file deploy@host:/var/www/app")}>Upload</button>
                <button className="btn btn-secondary btn-sm" onClick={() => triggerFileAction("下载主机文件", "下载当前目录文件做本地分析", "scp deploy@host:/var/www/app/config ./config.backup")}>Download</button>
                <button className="btn btn-secondary btn-sm" onClick={() => triggerFileAction("创建远程目录", "在当前目录下创建新文件夹", "mkdir -p /var/www/app/releases")}>New Folder</button>
                <div className="sftp-path" style={{ marginLeft: "auto" }}>
                  <span>/</span>
                  <span className="sep">/</span>
                  <span>var</span>
                  <span className="sep">/</span>
                  <span>www</span>
                  <span className="sep">/</span>
                  <span>app</span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.files.map((file) => (
                    <tr key={file.name}>
                      <td>{file.name}</td>
                      <td className="text-muted">{file.type}</td>
                      <td className="text-muted">{file.size}</td>
                      <td className="text-muted">{file.modified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ssh-side-stack">
              <div className="panel">
                <div className="panel-header">
                  <h3>文件闭环</h3>
                </div>
                <div className="panel-body action-list">
                  <div className="action-row">
                    <span className="action-title">配置文件</span>
                    <span className="action-meta">适合先下载、差异比对，再联动终端做热加载验证。</span>
                  </div>
                  <div className="action-row">
                    <span className="action-title">部署脚本</span>
                    <span className="action-meta">与 Workflow 模块共用一套发布上下文，避免手工改动漂移。</span>
                  </div>
                  <div className="action-row">
                    <span className="action-title">回到终端</span>
                    <span className="action-meta">完成文件操作后建议立即进入终端执行校验命令与留痕。</span>
                  </div>
                </div>
              </div>
              <div className="panel">
                <div className="panel-header">
                  <h3>快捷跳转</h3>
                </div>
                <div className="panel-body ssh-module-list">
                  <button type="button" className="ssh-module-item" onClick={() => openTerminal(profile.presets[0])}>
                    <span className="action-title">打开排障终端</span>
                    <span className="action-meta">把当前文件上下文带入终端工作区继续处理。</span>
                  </button>
                  <button type="button" className="ssh-module-item" onClick={() => openModule("/workflow")}>
                    <span className="action-title">同步到 Workflow</span>
                    <span className="action-meta">将文件改动纳入发布或巡检链路。</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {detailTab === "tunnels" && (
          <div className="ssh-workbench-grid">
            <div className="panel">
              <div className="panel-header">
                <h3>SSH Tunnels</h3>
                <button className="btn btn-primary btn-sm" onClick={() => triggerTunnelAction("创建 SSH Tunnel", "为数据库或内部服务建立新的端口转发", "ssh -L 5432:prod-db-master:5432 deploy@host")}>+ New Tunnel</button>
              </div>
              <div className="panel-body action-list">
                {profile.tunnels.map((tunnel) => (
                  <div key={`${tunnel.local}-${tunnel.remote}`} className="action-row" style={{ alignItems: "flex-start" }}>
                    <span className="action-title">{tunnel.local}</span>
                    <span className="action-meta">{tunnel.remote} · {tunnel.status}</span>
                    <div className="flex gap-2" style={{ marginLeft: "auto", flexShrink: 0 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => triggerTunnelAction("检查 Tunnel 状态", `检查 ${tunnel.local} 到 ${tunnel.remote} 的转发状态`, `lsof -i ${tunnel.local.split(":").at(-1) ?? "5432"}`)}>Inspect</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => openModule("/database", "prod-db-master")}>DB</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="ssh-side-stack">
              <div className="panel">
                <div className="panel-header">
                  <h3>Tunnel 闭环</h3>
                </div>
                <div className="panel-body action-list">
                  <div className="action-row">
                    <span className="action-title">数据库只读排查</span>
                    <span className="action-meta">先经 Tunnel 进入目标库，再把 SQL 交给数据库模块审阅。</span>
                  </div>
                  <div className="action-row">
                    <span className="action-title">内部服务调试</span>
                    <span className="action-meta">通过本地转发把未暴露的服务接入统一终端与协议调试模块。</span>
                  </div>
                  <div className="action-row">
                    <span className="action-title">当前概况</span>
                    <span className="action-meta">活动 {activeTunnelCount} 条 · 空闲 {idleTunnelCount} 条。</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {detailTab === "monitoring" && (
          <div className="ssh-workbench-grid">
            <div>
              <div className="quick-stats">
                <div className="quick-stat">
                  <div className="stat-label">Load</div>
                  <div className="stat-value">1.24</div>
                </div>
                <div className="quick-stat">
                  <div className="stat-label">Network</div>
                  <div className="stat-value">{profile.network}</div>
                </div>
                <div className="quick-stat">
                  <div className="stat-label">Processes</div>
                  <div className="stat-value">126</div>
                </div>
                <div className="quick-stat">
                  <div className="stat-label">Alerts</div>
                  <div className="stat-value">{warnActivityCount}</div>
                </div>
              </div>
              <div className="chart-area">
                <div className="chart-header">
                  <h3>CPU Trend</h3>
                  <div className="chart-tabs">
                    <span className="chart-tab active">1H</span>
                    <span className="chart-tab">6H</span>
                    <span className="chart-tab">24H</span>
                  </div>
                </div>
                <div className="chart-body">
                  {[20, 24, 22, 26, 31, 28, 24, 21, 18, 23, 27, 25, 21, 19, 16, 22].map((value, index) => (
                    <div key={index} className="chart-bar" style={{ height: `${value * 3}px` }} />
                  ))}
                </div>
              </div>
            </div>
            <div className="ssh-side-stack">
              <div className="panel">
                <div className="panel-header">
                  <h3>监控结论</h3>
                </div>
                <div className="panel-body action-list">
                  <div className="action-row">
                    <span className="action-title">当前建议</span>
                    <span className="action-meta">先看健康检查，再看容器日志，最后决定是否进入发布 / 回滚链路。</span>
                  </div>
                  <div className="action-row">
                    <span className="action-title">风险提示</span>
                    <span className="action-meta">{warnActivityCount > 0 ? `最近存在 ${warnActivityCount} 条预警动作，需要复核。` : "近期没有明显风险动作，可继续做验证与维护。"}</span>
                  </div>
                </div>
              </div>
              <div className="panel">
                <div className="panel-header">
                  <h3>排查入口</h3>
                </div>
                <div className="panel-body term-command-pack">
                  {recommendedCommands.slice(0, 4).map((command) => (
                    <button key={command} type="button" className="term-command-chip" onClick={() => runRecommendedCommand(command)}>
                      {command}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const tunnelsView = (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">Port Tunnels</div>
          <div className="host-addr-detail">为常用数据库、缓存和内部服务建立安全转发</div>
        </div>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={() => triggerTunnelAction("创建全局 Tunnel", "从 Tunnel 总览页新建安全转发", "ssh -L 8080:127.0.0.1:8080 deploy@host")}>
          + New Tunnel
        </button>
      </div>
      <div className="ssh-detail-body ssh-workbench-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>全部 Tunnel</h3>
          </div>
          <div className="panel-body">
            <table>
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Remote</th>
                  <th>Host</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sshResources.flatMap((resource) => getProfile(resource).tunnels.map((tunnel) => ({ resource, tunnel }))).map(({ resource, tunnel }) => (
                  <tr key={`${resource.id}-${tunnel.local}-${tunnel.remote}`}>
                    <td>{tunnel.local}</td>
                    <td>{tunnel.remote}</td>
                    <td>{resource.name}</td>
                    <td>
                      <span className={`badge ${tunnel.status === "Active" ? "badge-success" : "badge-muted"}`}>{tunnel.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="ssh-side-stack">
          <div className="panel">
            <div className="panel-header">
              <h3>使用建议</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">数据库调试</span>
                <span className="action-meta">优先走只读链路，避免在生产侧直接暴露数据库端口。</span>
              </div>
              <div className="action-row">
                <span className="action-title">服务联调</span>
                <span className="action-meta">把内部服务转发到本地后，可继续联动协议调试与终端会话。</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const keysView = (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">SSH Keys</div>
          <div className="host-addr-detail">统一管理密钥、用途、覆盖主机与风险范围</div>
        </div>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={() => triggerKeyAction("导入 SSH 密钥", "从密钥总览页导入新的 SSH Key", "ssh-add ~/.ssh/new_key")}>
          + Import Key
        </button>
      </div>
      <div className="ssh-detail-body ssh-workbench-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>Available Keys</h3>
          </div>
          <div className="panel-body action-list">
            {SSH_KEYS.map((key) => (
              <div key={key.name} className="action-row">
                <span className="action-title">{key.name}</span>
                <span className="action-meta">{key.meta} · {key.usage}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="ssh-side-stack">
          <div className="panel">
            <div className="panel-header">
              <h3>覆盖情况</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">当前主机</span>
                <span className="action-meta">{hostName} 使用 {profile.keyFile}，覆盖范围 {profile.keyScope}。</span>
              </div>
              <div className="action-row">
                <span className="action-title">密钥命中</span>
                <span className="action-meta">当前画像已匹配 {keyCoverage} 组密钥信息，可继续做轮换或权限治理。</span>
              </div>
              <div className="action-row">
                <span className="action-title">与终端协同</span>
                <span className="action-meta">密钥与主机上下文进入终端工作区后，才能形成真正可复用的运维工作台。</span>
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h3>治理建议</h3>
            </div>
            <div className="panel-body action-list">
              <div className="action-row">
                <span className="action-title">连接治理</span>
                <span className="action-meta">SSH 模块不只是连上主机，还要对密钥边界、风险范围与工作流授权负责。</span>
              </div>
              <div className="action-row">
                <span className="action-title">轮换策略</span>
                <span className="action-meta">建议按环境划分密钥，避免生产、预发与跳板机共用长期凭据。</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="ssh-layout">
      {moduleTab === "hosts" && <HostListPanel resources={sshResources} />}
      {moduleTab === "hosts" ? hostOverview : moduleTab === "tunnels" ? tunnelsView : keysView}
      <div className="statusbar" style={{ position: "absolute", left: -99999, width: 1, height: 1, overflow: "hidden" }} aria-hidden="true">
        <span className="statusbar-item">{onlineHosts}</span>
        <span className="statusbar-item">{offlineHosts}</span>
      </div>
    </div>
  );
}

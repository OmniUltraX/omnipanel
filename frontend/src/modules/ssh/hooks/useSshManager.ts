import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSshHostResources } from "../../../stores/connectionStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { useActionStore } from "../../../stores/actionStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useTopbarTabs } from "../../../hooks/useTopbarTabs";
import { useI18n } from "../../../i18n";
import { MODULE_TABS, SSH_PATH } from "../constants";
import { getProfile } from "../data/hostProfiles";
import { SSH_KEYS } from "../data/sshKeys";
import type { DetailTab, HostSignal, LaunchPreset, ModuleTab } from "../types";

export function useSshManager() {
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

  const sshResources = useSshHostResources();
  const resolvedSsh = getResourceForPath(SSH_PATH);
  const activeResource =
    resolvedSsh?.type === "ssh" ? resolvedSsh : (sshResources[0] ?? null);
  const profile = getProfile(activeResource);

  const onlineHosts = useMemo(
    () => sshResources.filter((resource) => resource.status !== "offline").length,
    [sshResources],
  );
  const offlineHosts = useMemo(
    () => sshResources.filter((resource) => resource.status === "offline").length,
    [sshResources],
  );
  const hostAddress = activeResource?.subtitle?.split("@").at(-1) ?? "10.0.1.10:22";
  const hostName = activeResource?.name ?? "prod-web-01";
  const activeTunnelCount = profile.tunnels.filter(
    (tunnel) => tunnel.status === "Active",
  ).length;
  const idleTunnelCount = profile.tunnels.length - activeTunnelCount;
  const warnActivityCount = profile.recentActivity.filter(
    (item) => item.status === "warn",
  ).length;
  const keyCoverage =
    SSH_KEYS.filter(
      (key) =>
        profile.keyFile.includes(key.name.replace(/^.*\//, "")) ||
        key.usage.toLowerCase().includes(profile.username.toLowerCase()),
    ).length || 1;

  const recommendedCommands = useMemo(
    () =>
      Array.from(
        new Set([
          ...profile.presets.flatMap((preset) => preset.commands),
          ...profile.recentActivity.map((item) => item.command),
        ]),
      ).slice(0, 6),
    [profile],
  );

  const operationalChecklist = useMemo(
    () => [
      `先确认 ${hostName} 当前状态与最近 ${profile.recentActivity.length} 条操作记录。`,
      `优先从 ${profile.presets[0]?.title ?? "标准会话"} 进入终端工作区，减少重复跳转。`,
      activeTunnelCount > 0
        ? `已有 ${activeTunnelCount} 条活动 Tunnel，可直接串联数据库或内部服务调试。`
        : "当前没有活动 Tunnel，需要时先建立最小必要转发。",
      warnActivityCount > 0
        ? `最近存在 ${warnActivityCount} 条风险动作，完成处理后记得回写工作流与巡检记录。`
        : "最近操作稳定，可继续做发布验证或维护动作。",
    ],
    [activeTunnelCount, hostName, profile, warnActivityCount],
  );

  const hostSignals: HostSignal[] = useMemo(
    () => [
      {
        title:
          activeResource?.status === "warning"
            ? "主机状态需要关注"
            : "主机状态稳定",
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
        desc:
          profile.notes[0] ??
          "SSH 页面应该承担连接、命令包、SFTP、Tunnel 与联动入口的职责。",
      },
    ],
    [activeResource?.status, profile],
  );

  const topbarTabs = useMemo(
    () =>
      MODULE_TABS.map((tab) => ({
        id: tab,
        label: t(`ssh.tabs.${tab}`),
        active: moduleTab === tab,
      })),
    [moduleTab, t],
  );

  useTopbarTabs(topbarTabs, { onSelect: (id) => setModuleTab(id as ModuleTab) }, {
    mode: "segment",
  });

  useEffect(() => {
    if (
      !useWorkspaceStore.getState().selectedResourceByPath[SSH_PATH] &&
      sshResources[0]
    ) {
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
    [activeResource, enqueueAction],
  );

  const openModule = useCallback(
    (path: string, resourceId?: string) => {
      if (resourceId) {
        selectResource(resourceId, path);
      }
      setActivePath(path);
      navigate(path);
    },
    [navigate, selectResource, setActivePath],
  );

  const openTerminal = useCallback(
    (preset?: LaunchPreset, forceNew = false) => {
      if (!activeResource) return;
      const purpose = preset?.purpose ?? "SSH Workbench";
      const existing = terminalTabs.find((tab) => {
        const activePane =
          tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
        return (
          activePane?.resourceId === activeResource.id &&
          activePane.purpose === purpose
        );
      });

      queueSshAction(
        preset ? preset.title : t("ssh.actions.openSession"),
        preset?.desc ?? "打开远程会话工作台",
        preset?.commands[0] ?? "ssh connect",
      );

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
    [
      activeResource,
      addTerminalTab,
      navigate,
      queueSshAction,
      setActivePath,
      setTerminalTab,
      t,
      terminalTabs,
    ],
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
        false,
      );
    },
    [openTerminal],
  );

  const triggerFileAction = useCallback(
    (title: string, description: string, command?: string) => {
      queueSshAction(title, description, command);
    },
    [queueSshAction],
  );

  const triggerTunnelAction = useCallback(
    (title: string, description: string, command?: string) => {
      queueSshAction(title, description, command);
    },
    [queueSshAction],
  );

  const triggerKeyAction = useCallback(
    (title: string, description: string, command?: string) => {
      queueSshAction(title, description, command);
    },
    [queueSshAction],
  );

  return {
    t,
    moduleTab,
    detailTab,
    setDetailTab,
    sshResources,
    activeResource,
    profile,
    onlineHosts,
    offlineHosts,
    hostAddress,
    hostName,
    activeTunnelCount,
    idleTunnelCount,
    warnActivityCount,
    keyCoverage,
    recommendedCommands,
    operationalChecklist,
    hostSignals,
    openModule,
    openTerminal,
    runRecommendedCommand,
    triggerFileAction,
    triggerTunnelAction,
    triggerKeyAction,
  };
}

export type SshManagerContext = ReturnType<typeof useSshManager>;

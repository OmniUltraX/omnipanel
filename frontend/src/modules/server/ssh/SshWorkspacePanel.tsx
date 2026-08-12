import { memo, useCallback, useMemo } from "react";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";
import { HostDetailPanel } from "./components/HostDetailPanel";
import { useSshActiveHostStore } from "./stores/sshActiveHostStore";
import { useUiFollowConsumer } from "../../../lib/ai/uiFollow";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { SSH_PATH } from "./constants";

type Props = {
  enabled?: boolean;
  /** 嵌入终端 Dock 的 SSH 管理 Tab（历史兼容，现由独立 SSH 模块承载） */
  embedded?: boolean;
};

/**
 * SSH 工作区面板：右侧仅展示主机详情；隧道 / 密钥在左侧边栏内完成全部操作。
 */
export const SshWorkspacePanel = memo(function SshWorkspacePanel({
  enabled = true,
  embedded = false,
}: Props) {
  const { t } = useI18n();
  const rememberedHostId = useWorkspaceStore((s) => s.selectedResourceByPath[SSH_PATH]);
  const activeHostId = useSshActiveHostStore((s) => s.activeHostId) ?? rememberedHostId ?? null;
  const setActiveHostId = useSshActiveHostStore((s) => s.setActiveHostId);

  useUiFollowConsumer("ssh", useCallback((intent) => {
    switch (intent.type) {
      case "openConnection": {
        if (intent.module !== "ssh") return false;
        setActiveHostId(intent.resourceId);
        return true;
      }
      case "revealSftpPath": {
        setActiveHostId(intent.resourceId);
        return true;
      }
      default:
        return false;
    }
  }, [setActiveHostId]));

  const panelBody = useMemo(() => {
    return (
      <div className="ssh-hosts-workspace">
        {activeHostId ? (
          <HostDetailPanel hostId={activeHostId} />
        ) : (
          <WorkspaceEmptyPage title={t("routes.ssh")} prompt={t("ssh.empty.selectHost")} />
        )}
      </div>
    );
  }, [activeHostId, t]);

  if (!enabled) {
    return null;
  }

  return (
    <div className={`ssh-workspace-panel${embedded ? " ssh-workspace-panel--embedded" : ""}`}>
      <div className="ssh-workspace-panel__body">{panelBody}</div>
    </div>
  );
});

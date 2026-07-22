import { memo, useCallback, useMemo } from "react";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { HostDetailPanel } from "./components/HostDetailPanel";
import { useSshActiveHostStore } from "./stores/sshActiveHostStore";
import { useUiFollowConsumer } from "../../../lib/ai/uiFollow";
import { SSH_PATH } from "./constants";

type Props = {
  enabled?: boolean;
  /** 嵌入终端 Dock 的 SSH 管理 Tab */
  embedded?: boolean;
};

/**
 * SSH 工作区面板：右侧仅展示主机详情；隧道 / 密钥在左侧边栏内完成全部操作。
 * 嵌入终端时由外层 Terminal Dock 提供「SSH 管理」固定 Tab。
 */
export const SshWorkspacePanel = memo(function SshWorkspacePanel({
  enabled = true,
  embedded = false,
}: Props) {
  const { t } = useI18n();
  const rememberedHostId = useWorkspaceStore((s) => s.selectedResourceByPath[SSH_PATH]);
  const activeHostId = useSshActiveHostStore((s) => s.activeHostId) ?? rememberedHostId ?? null;
  const setActiveHostId = useSshActiveHostStore((s) => s.setActiveHostId);

  // === AI Follow 消费者注册 ===
  // 处理 openConnection / revealSftpPath intent：同步 activeHostId，避免被旧值覆盖
  useUiFollowConsumer("ssh", useCallback((intent) => {
    switch (intent.type) {
      case "openConnection": {
        setActiveHostId(intent.resourceId);
        return true;
      }
      case "revealSftpPath": {
        // 切到对应主机，SFTP 路径定位由终端面板的 SFTP 集成处理
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

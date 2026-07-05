import { memo, useMemo, useState } from "react";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";
import { useSshHostResources } from "../../../stores/connectionStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { HostDetailPanel } from "./components/HostDetailPanel";
import { FleetSummaryBar } from "./components/FleetSummaryBar";
import { BatchCommandPanel } from "./components/BatchCommandPanel";
import { useSshActiveHostStore } from "./stores/sshActiveHostStore";
import { useSshSelectionStore } from "./stores/sshSelectionStore";
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
  const sshResources = useSshHostResources();
  const rememberedHostId = useWorkspaceStore((s) => s.selectedResourceByPath[SSH_PATH]);
  const activeHostId = useSshActiveHostStore((s) => s.activeHostId) ?? rememberedHostId ?? null;
  const selectedIds = useSshSelectionStore((s) => s.selectedIds);
  const [batchOpen, setBatchOpen] = useState(false);

  const panelBody = useMemo(() => {
    const showBatch = batchOpen && selectedIds.length > 0;
    return (
      <div className="ssh-hosts-workspace">
        <FleetSummaryBar resources={sshResources} onOpenBatch={() => setBatchOpen(true)} />
        {showBatch ? (
          <BatchCommandPanel resources={sshResources} onClose={() => setBatchOpen(false)} />
        ) : activeHostId ? (
          <HostDetailPanel hostId={activeHostId} />
        ) : (
          <WorkspaceEmptyPage title={t("routes.ssh")} prompt={t("ssh.empty.selectHost")} />
        )}
      </div>
    );
  }, [activeHostId, batchOpen, selectedIds.length, sshResources, t]);

  if (!enabled) {
    return null;
  }

  return (
    <div className={`ssh-workspace-panel${embedded ? " ssh-workspace-panel--embedded" : ""}`}>
      <div className="ssh-workspace-panel__body">{panelBody}</div>
    </div>
  );
});

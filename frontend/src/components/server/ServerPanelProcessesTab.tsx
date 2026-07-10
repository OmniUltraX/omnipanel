import { useI18n } from "@/i18n";
import type { ServerEntry } from "@/modules/server/panel/serverConnection";
import { findSshForPanel } from "@/modules/server/panel/serverConnection";
import { useSshOverview } from "@/modules/server/ssh/hooks/useSshOverview";
import { useConnectionStore } from "@/stores/connectionStore";
import { ProcessListPanel } from "./ProcessListPanel";

interface Props {
  server: ServerEntry;
}

/** 服务器面板进程 Tab：通过关联 SSH 连接拉取进程列表 */
export function ServerPanelProcessesTab({ server }: Props) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const sshConn = findSshForPanel(connections, server.id);
  const resourceId = sshConn?.id ?? null;

  const {
    processes,
    processError,
    error,
    updatedAt,
    refreshing,
    refreshProcesses,
  } = useSshOverview(resourceId);

  if (!resourceId) {
    return (
      <div className="server-panel-tab">
        <div className="server-apps-empty">{t("server.processes.noLinkedSsh")}</div>
      </div>
    );
  }

  return (
    <ProcessListPanel
      resourceId={resourceId}
      processes={processes}
      loading={refreshing}
      refreshing={refreshing}
      updatedAt={updatedAt}
      error={processError ?? error}
      onRefresh={refreshProcesses}
      variant="monitor"
    />
  );
}

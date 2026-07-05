import { useI18n } from "../../../../i18n";
import { ResourceTags } from "../../../../components/ui/tags/ResourceTags";
import { useConnectionStore } from "../../../../stores/connectionStore";
import { normalizeSshGroup, sshGroupLabel } from "../../../../lib/sshGroups";
import { DETAIL_TABS } from "../constants";
import type { DetailTab } from "../types";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { HostStatusIndicator } from "./HostStatusIndicator";
import { useSshMonitoring } from "../hooks/useSshMonitoring";
import type { useSshHostActions } from "../hooks/useSshHostActions";
import type { SshHostContext } from "../hooks/useSshHostContext";
import { formatUptime } from "./monitoring/monitoringUtils";

type Actions = ReturnType<typeof useSshHostActions>;

type Props = {
  resource: WorkspaceResource;
  username: string;
  hostAddress: string;
  context: SshHostContext;
  detailTab: DetailTab;
  onDetailTabChange: (tab: DetailTab) => void;
  actions: Actions;
};

function HostDetailTags({ resourceId }: { resourceId: string }) {
  const tags = useConnectionStore(
    (s) => s.connections.find((c) => c.id === resourceId)?.tags,
  );
  return <ResourceTags tags={tags} variant="detail" />;
}

function MonitoringTabSwitch({ resourceId }: { resourceId: string }) {
  const { t } = useI18n();
  const { enabled, enable, disable } = useSshMonitoring(resourceId);

  return (
    <label className="ssh-detail-toolbar__monitor" title={t("ssh.monitoring.hint")}>
      <span className="ssh-detail-toolbar__monitor-label">{t("ssh.monitoring.title")}</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className={`ssh-monitor-switch-btn${enabled ? " active" : ""}`}
        onClick={() => {
          if (enabled) void disable();
          else void enable();
        }}
      >
        <span className="ssh-monitor-switch-thumb" />
      </button>
    </label>
  );
}

export function HostDetailToolbar({
  resource,
  username,
  hostAddress,
  context,
  detailTab,
  onDetailTabChange,
  actions,
}: Props) {
  const { t } = useI18n();

  const metaParts = [
    context.osInfo,
    context.uptimeSecs != null
      ? t("ssh.profile.uptime", { uptime: formatUptime(context.uptimeSecs) })
      : null,
    context.dockerConnection
      ? t("ssh.profile.dockerRunning", {
          running: context.dockerConnection.containersRunning,
          total: context.dockerConnection.containersTotal,
        })
      : null,
    context.panelServiceLabel ? context.panelServiceLabel : null,
  ].filter(Boolean);

  const quickActions = [
    { id: "terminal", label: t("ssh.actions.openTerminal"), onClick: actions.openTerminal, disabled: false },
    { id: "sftp", label: t("ssh.actions.openSftp"), onClick: actions.openSftp, disabled: false },
    {
      id: "docker",
      label: t("ssh.quickActions.docker"),
      onClick: actions.openDocker,
      disabled: !actions.hasDocker,
      title: !actions.hasDocker ? t("ssh.quickActions.dockerMissing") : undefined,
    },
    {
      id: "panel",
      label: t("ssh.quickActions.panel"),
      onClick: actions.openPanel,
      disabled: !actions.hasPanel,
      title: !actions.hasPanel ? t("ssh.quickActions.panelMissing") : undefined,
    },
  ];

  return (
    <div className="ssh-detail-toolbar">
      <div className="ssh-detail-toolbar__identity">
        <span className={`ssh-detail-toolbar__dot ssh-detail-toolbar__dot--${resource.status ?? "online"}`} />
        <div className="ssh-detail-toolbar__identity-text">
          <div className="ssh-detail-toolbar__title-row">
            <span className="ssh-detail-toolbar__name">{resource.name}</span>
            <HostDetailTags resourceId={resource.id} />
            <HostStatusIndicator resourceId={resource.id} showLabel />
            <span className="badge badge-muted">
              {sshGroupLabel(normalizeSshGroup(resource.group), t)}
            </span>
          </div>
          <div className="ssh-detail-toolbar__meta">
            <span>{username}@{hostAddress}</span>
            {metaParts.length > 0 && (
              <>
                <span className="ssh-detail-toolbar__sep">·</span>
                <span>{metaParts.join(" · ")}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="ssh-detail-toolbar__center">
        <div className="ssh-detail-toolbar__tabs" role="tablist">
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={detailTab === tab}
              className={`ssh-detail-toolbar__tab${detailTab === tab ? " active" : ""}`}
              onClick={() => onDetailTabChange(tab)}
            >
              {t(`ssh.detailTabs.${tab}`)}
            </button>
          ))}
        </div>
        <div className="ssh-detail-toolbar__actions">
          {quickActions.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ssh-detail-toolbar__action"
              onClick={item.onClick}
              disabled={item.disabled}
              title={item.title ?? item.label}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <MonitoringTabSwitch resourceId={resource.id} />
    </div>
  );
}

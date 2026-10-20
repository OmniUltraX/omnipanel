import { useI18n } from "../../../../i18n";
import { SidebarStatusDot, type SidebarStatus } from "../../../../components/ui/module-sidebar";
import { StatusDot } from "../../../../components/ui/primitives/StatusDot";
import { useSshHostStore } from "../../../../stores/sshHostStore";
import {
  hostStatusDotStatus,
  useHostConnectionIndicatorStatus,
  useHostReachabilityStatus,
} from "../../../../stores/sshConnectionStore";

type Props = {
  resourceId: string | null | undefined;
  showLabel?: boolean;
  className?: string;
};

export function HostStatusIndicator({ resourceId, showLabel = false, className }: Props) {
  const { t } = useI18n();
  const status = useHostConnectionIndicatorStatus(resourceId ?? null);
  const reachability = useHostReachabilityStatus(resourceId ?? null);
  const label =
    status === "online"
      ? t("ssh.status.online")
      : status === "connecting"
        ? t("ssh.status.connecting")
        : status === "offline"
          ? t("ssh.status.offline")
          : t("ssh.status.unknown");
  const reachabilityHint =
    reachability === "online"
      ? t("ssh.status.reachable")
      : reachability === "offline"
        ? t("ssh.status.unreachable")
        : null;
  // 性能监控开关并入状态点悬停提示，行内只保留一个点。
  const monitoring = useSshHostStore((s) => s.isMonitoring(resourceId ?? ""));
  const title = [label, reachabilityHint, monitoring ? t("ssh.monitoring.active") : null]
    .filter(Boolean)
    .join(" · ");

  const mapped = hostStatusDotStatus(status);
  const sidebarStatus: SidebarStatus =
    mapped === "online" || mapped === "connecting" || mapped === "offline" ? mapped : "idle";
  const dot = showLabel ? (
    <StatusDot
      status={mapped}
      title={title}
      label={label}
      size="sm"
      className={className}
    />
  ) : (
    <SidebarStatusDot status={sidebarStatus} title={title} label={label} className={className} />
  );

  if (showLabel) {
    return (
      <span className={`ssh-detail-status ssh-detail-status--${status}${className ? ` ${className}` : ""}`}>
        {dot}
        {label}
      </span>
    );
  }

  return dot;
}

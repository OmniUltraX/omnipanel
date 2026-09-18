import { useI18n } from "../../../../i18n";
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

  const dot = (
    <StatusDot
      status={hostStatusDotStatus(status)}
      title={title}
      label={label}
      size="sm"
      className={showLabel ? undefined : className}
    />
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

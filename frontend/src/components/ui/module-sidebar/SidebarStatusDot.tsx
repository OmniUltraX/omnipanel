import { StatusDot, type StatusDotStatus } from "../primitives/StatusDot";

/**
 * 侧栏树状态点：`StatusDot` 的语义收口。
 *
 * 全模块同一主机在 SSH 列表 / 终端会话树 / Docker 主机树中必须同色同形，
 * 因此侧栏一律用本组件，禁止 `topbar-tab-dot` / `HostStatusIndicator` 等散装实现。
 */
export type SidebarStatus = Extract<
  StatusDotStatus,
  "online" | "connecting" | "offline" | "idle"
>;

export function SidebarStatusDot({
  status,
  title,
  label,
  className,
}: {
  status: SidebarStatus;
  title?: string;
  label?: string;
  className?: string;
}) {
  return (
    <StatusDot
      status={status}
      title={title}
      label={label}
      size="xs"
      className={["sidebar-status-dot", className].filter(Boolean).join(" ")}
    />
  );
}

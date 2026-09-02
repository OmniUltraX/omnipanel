/** 通用资源状态点：SSH / 数据库 / Docker / 第三方服务 / 文件 / 云侧边栏共用。 */
export type StatusDotStatus = "online" | "connecting" | "offline" | "idle" | "unknown";

/** xs = 6px（侧栏树节点默认）；sm = 8px（SSH 主机列表）。 */
export type StatusDotSize = "xs" | "sm";

export type StatusDotProps = {
  status: StatusDotStatus;
  /** 悬停提示（推荐传入状态文案或错误信息） */
  title?: string;
  /** 无障碍标签；不传时对屏幕阅读器隐藏 */
  label?: string;
  size?: StatusDotSize;
  className?: string;
};

export function StatusDot({ status, title, label, size = "xs", className }: StatusDotProps) {
  const classes = [
    "status-dot",
    `status-dot--${status}`,
    size === "sm" ? "status-dot--sm" : "",
    status === "connecting" ? "status-dot--pulse" : "",
    className ?? "",
  ].filter(Boolean);

  return (
    <span
      className={classes.join(" ")}
      title={title}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

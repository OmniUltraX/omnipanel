/**
 * 侧栏统一刷新图标（V1：16 格圆箭头，12px）。
 *
 * 审计结论：仓库里有三种刷新线形（16 格圆箭头 / 24 格 `M23 4v6h-6` / feather 风 `IconRefresh`），
 * 侧栏一律用本组件；24 格版仅保留给容器"重启"等非刷新语义与设置页存量，右侧面板暂不动。
 */
export function SidebarRefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="12"
      height="12"
      aria-hidden
    >
      <path d="M2 8a6 6 0 0 1 10.5-3.9" />
      <path d="M14 2v3h-3" />
      <path d="M14 8a6 6 0 0 1-10.5 3.9" />
      <path d="M2 14v-3h3" />
    </svg>
  );
}

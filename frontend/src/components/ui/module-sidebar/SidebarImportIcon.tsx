/**
 * 侧栏统一导入图标：箭头落入敞口托盘。
 *
 * 与下载区分：下载是"下箭头 + 一横线"（落到地面）；导入是"箭头 + U 形敞口托盘"
 * （收进容器），呼应"把外部配置收进侧栏"的语义。此前各模块导入按钮长得各异
 * （SSH 直接复用下载图标），现统一为本组件。
 */
export function SidebarImportIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="12"
      height="12"
      aria-hidden
    >
      <path d="M12 3v8" />
      <path d="M8.5 7.5 12 11l3.5-3.5" />
      <path d="M5 12v7h14v-7" />
    </svg>
  );
}

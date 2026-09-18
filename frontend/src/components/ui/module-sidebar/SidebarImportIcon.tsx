/**
 * 侧栏统一导入图标：箭头落入托盘（与下载区分：下载是单纯下箭头）。
 *
 * 此前各模块导入按钮长得各异（SSH 直接复用下载图标），现统一为本组件。
 */
export function SidebarImportIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      width="12"
      height="12"
      aria-hidden
    >
      <path d="M12 3v12" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </svg>
  );
}

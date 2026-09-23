/**
 * 查询分组工具栏图标。
 * 与侧栏一致：24 viewBox、1.8 描边、圆角端点。工具栏用 12px，树节点用 14px。
 */
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** 新建 SQL 查询：与查询文件同一套文档图形。 */
export function SqlNewQueryIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconProps} width={size} height={size}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  );
}

/** 新建树图：自上而下的分叉，不用表格状的竖条。 */
export function TreeChartIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconProps} width={size} height={size}>
      <rect x="9" y="3" width="6" height="4.5" rx="1" />
      <path d="M12 7.5v3.5" />
      <path d="M6 11h12" />
      <path d="M6 11v2.5" />
      <path d="M18 11v2.5" />
      <rect x="3" y="13.5" width="6" height="4.5" rx="1" />
      <rect x="15" y="13.5" width="6" height="4.5" rx="1" />
    </svg>
  );
}

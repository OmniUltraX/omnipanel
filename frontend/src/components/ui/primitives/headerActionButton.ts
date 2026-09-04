/** 工作台页头 / 行内文字按钮：幽灵字色，悬停强调。危险操作加 `--danger`。 */
export function headerActionButtonClass(danger = false): string {
  return danger
    ? "workbench-panel-header-action-btn workbench-panel-header-action-btn--danger"
    : "workbench-panel-header-action-btn";
}

/**
 * 侧栏乐观高亮（pending）兜底策略。
 *
 * pointerdown 当帧点亮目标是“跟手”的来源；location 提交后由路由 effect
 * 负责清除 pending。定时器兜底只处理“根本没发生导航”的情况（拖拽、
 * 右键、pointerdown 后未点击），必须 location-aware：
 * 若 location 已离开起点（导航在途中，含 startTransition 慢提交），
 * 此时清除 pending 会把高亮打回旧项，造成 B→A→B 回闪。
 */

export const SIDEBAR_PENDING_BACKSTOP_MS = 1500;

/** pointerdown 时记录的起点 location；超时后仍停在这里 = 没有导航发生。 */
export function readCurrentPathname(): string {
  return window.location.pathname;
}

/**
 * 超时兜底是否应该清除 pending：
 * location 纹丝不动 → 清（无导航发生，防残留）；
 * location 已离开起点 → 不清（导航在途中，等路由 effect 按 location 结算）。
 */
export function shouldClearPendingOnBackstop(fromPathname: string): boolean {
  return readCurrentPathname() === fromPathname;
}

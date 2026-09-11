/**
 * 顶栏 WHERE / ORDER BY 输入框失焦提交的取消注册表。
 *
 * 背景：两个单行输入失焦 120ms 后会自动提交（整体替换过滤/排序）。
 * 若用户在顶栏有未提交草稿时去点列头漏斗、右键筛选、快捷筛选等入口，
 * 面板按打开时的旧过滤构建，稍后触发的失焦提交 / 面板应用会互相覆盖，
 * 表现为“清一列却丢了其他条件”。因此所有筛选/排序入口先取消待提交。
 */
type BlurCommitCanceler = () => void;

const cancelers = new Set<BlurCommitCanceler>();

export function registerBlurCommitCanceler(canceler: BlurCommitCanceler): () => void {
  cancelers.add(canceler);
  return () => {
    cancelers.delete(canceler);
  };
}

/** 取消所有顶栏输入框待处理的失焦提交（幂等）。 */
export function cancelPendingBlurCommits(): void {
  cancelers.forEach((canceler) => {
    try {
      canceler();
    } catch {
      // 忽略单个输入框的清理异常
    }
  });
}

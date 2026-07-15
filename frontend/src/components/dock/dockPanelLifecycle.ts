/**
 * Dock 面板开/关时序约定：
 * - 打开：先同步改 Tab/激活状态，再 void 异步准备数据（面板内显示 loading）。
 * - 关闭：先同步从 dock 移除 Tab，再 void 异步收尾（dispose / persist / commit 等）。
 * 禁止在改 Tab 状态之前 await IPC（用户输入对话框除外）。
 */

export type OpenDockTabNowOptions = {
  /** 同步：addTab / activate / 设 loading 等 UI 状态 */
  applyTabSync: () => void;
  /** 异步：准备数据；错误由调用方自行 toast（可选） */
  prepareAsync?: () => void | Promise<void>;
};

export type CloseDockTabNowOptions = {
  /** 同步：从 dock / store 移除 Tab */
  removeTabSync: () => void;
  /** 异步：关 Tab 后的清理（dispose、commit、persist 等） */
  afterCloseAsync?: () => void | Promise<void>;
};

/** 先打开页面，再后台异步准备数据。 */
export function openDockTabNow({ applyTabSync, prepareAsync }: OpenDockTabNowOptions): void {
  applyTabSync();
  if (!prepareAsync) {
    return;
  }
  void Promise.resolve()
    .then(() => prepareAsync())
    .catch(() => {
      // 调用方应在 prepareAsync 内自行处理并 toast；此处仅吞掉未捕获拒绝以免 unhandledrejection
    });
}

/** 先关闭页面，再后台异步执行收尾。 */
export function closeDockTabNow({ removeTabSync, afterCloseAsync }: CloseDockTabNowOptions): void {
  removeTabSync();
  if (!afterCloseAsync) {
    return;
  }
  void Promise.resolve()
    .then(() => afterCloseAsync())
    .catch(() => {
      // 同上：错误由 afterCloseAsync 内部处理
    });
}

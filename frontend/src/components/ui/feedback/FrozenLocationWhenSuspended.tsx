import { useContext, type ReactNode } from "react";
import { UNSAFE_LocationContext } from "react-router-dom";

type LocationCtx = NonNullable<React.ContextType<typeof UNSAFE_LocationContext>>;

/** 各叠层在 active 时写入；suspend 后只读，避免再订阅 Router */
const lastLocationCtxByPanel = new Map<string, LocationCtx>();

/**
 * 模块 suspend 时冻结 Location，且 **Frozen 分支不订阅** Location context。
 *
 * 错误写法：suspend 时仍 useContext(Location) → 自己每路由必重渲 → 子树跟着重渲。
 * 正确写法：active 时捕获到 Map；suspend 时只读 Map 提供 Provider（本组件不订阅）。
 */
export function FrozenLocationWhenSuspended({
  suspended,
  panelId,
  children,
}: {
  suspended: boolean;
  /** 稳定面板 id，用于跨挂载保存上次 location */
  panelId: string;
  children: ReactNode;
}) {
  if (suspended) {
    return <FrozenBranch panelId={panelId}>{children}</FrozenBranch>;
  }
  return <LiveCaptureBranch panelId={panelId}>{children}</LiveCaptureBranch>;
}

/** 仅 active 时挂载：订阅 Location 并写入缓存 */
function LiveCaptureBranch({
  panelId,
  children,
}: {
  panelId: string;
  children: ReactNode;
}) {
  const ctx = useContext(UNSAFE_LocationContext);
  if (ctx != null) {
    lastLocationCtxByPanel.set(panelId, ctx);
  }
  return children;
}

/** 仅 suspend 时挂载：不订阅 Location，只提供上次缓存 */
function FrozenBranch({
  panelId,
  children,
}: {
  panelId: string;
  children: ReactNode;
}) {
  const frozen = lastLocationCtxByPanel.get(panelId);
  if (frozen == null) {
    return children;
  }
  return (
    <UNSAFE_LocationContext.Provider value={frozen}>
      {children}
    </UNSAFE_LocationContext.Provider>
  );
}

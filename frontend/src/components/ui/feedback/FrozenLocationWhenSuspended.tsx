import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { UNSAFE_LocationContext } from "react-router-dom";

type LocationCtx = NonNullable<React.ContextType<typeof UNSAFE_LocationContext>>;

/** 各叠层在 active 时写入；suspend 后只读，避免再订阅 Router */
const lastLocationCtxByPanel = new Map<string, LocationCtx>();

/**
 * 模块 suspend 时冻结 Location，且 **不因 suspended 切换而 remount 子树**。
 *
 * 历史坑：
 * - suspend 时仍 useContext(Location) → 每路由全模块重渲
 * - 用 LiveCaptureBranch / FrozenBranch 两个组件切换 → 子树（含 xterm）被卸载重建，
 *   切回模块时走 ensureBackendSession + restoreSnapshot，表现为「重连、历史没了」
 *
 * 正确写法：
 * - LiveCapture 为无 children 的兄弟节点，仅 active 时挂载（可卸载）
 * - Provider 壳类型恒定，从 Map 读冻结/最新 Location；suspend 切换不拆 children
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
  const [, bump] = useState(0);

  return (
    <>
      {!suspended ? (
        <LiveLocationCapture
          panelId={panelId}
          onCapture={() => bump((n) => n + 1)}
        />
      ) : null}
      <FrozenLocationProvider panelId={panelId}>{children}</FrozenLocationProvider>
    </>
  );
}

function FrozenLocationProvider({
  panelId,
  children,
}: {
  panelId: string;
  children: ReactNode;
}) {
  const ctx = lastLocationCtxByPanel.get(panelId) ?? null;
  if (ctx == null) {
    return children;
  }
  return (
    <UNSAFE_LocationContext.Provider value={ctx}>
      {children}
    </UNSAFE_LocationContext.Provider>
  );
}

/** 仅 active 时挂载：订阅 Location 并写入缓存；无 children，卸载不影响面板子树 */
function LiveLocationCapture({
  panelId,
  onCapture,
}: {
  panelId: string;
  onCapture: () => void;
}) {
  const ctx = useContext(UNSAFE_LocationContext);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const prevKeyRef = useRef<string | null>(null);

  // 写入快照（勿存 Router context 引用，否则后续导航会污染冻结值）
  if (ctx != null) {
    const key = `${ctx.location.key}:${ctx.location.pathname}${ctx.location.search}${ctx.location.hash}`;
    const prev = lastLocationCtxByPanel.get(panelId);
    const prevKey = prev
      ? `${prev.location.key}:${prev.location.pathname}${prev.location.search}${prev.location.hash}`
      : null;
    if (prevKey !== key) {
      lastLocationCtxByPanel.set(panelId, {
        location: { ...ctx.location },
        navigationType: ctx.navigationType,
      });
    }
  }

  useLayoutEffect(() => {
    if (ctx == null) return;
    const key = `${ctx.location.key}:${ctx.location.pathname}`;
    if (prevKeyRef.current === key) return;
    prevKeyRef.current = key;
    onCaptureRef.current();
  }, [ctx, panelId]);

  return null;
}

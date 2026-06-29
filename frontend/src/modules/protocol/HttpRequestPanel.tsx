import { useProtocolHttpDockStore } from "../../stores/protocolHttpDockStore";
import { HttpPanel } from "./HttpPanel";

/** 单个 HTTP 请求 Dock 面板；仅激活 Tab 渲染完整编辑器。 */
export function HttpRequestPanel({ requestId }: { requestId: string }) {
  const activeTabId = useProtocolHttpDockStore((state) => state.activeTabId);

  if (activeTabId !== requestId) {
    return <div className="http-panel http-panel--inactive" aria-hidden />;
  }

  return <HttpPanel />;
}

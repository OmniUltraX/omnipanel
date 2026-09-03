import { useCallback, useEffect, useRef, useState } from "react";

import { commands, type PanelProbeResult } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import { usePanelProbeStore } from "../stores/panelProbeStore";

/**
 * 面板（宝塔 / 1Panel）探测 hook。
 *
 * 与工具能力探测（useCapabilitiesStore）分开管理：
 * - 面板探测返回结构化数据（端口/安全入口/版本），不适合塞进 ToolState
 * - 探测结果写入 panelProbeStore，侧栏可展示已安装面板图标
 * - 探测会回填可用 API Key；没有则自动在远端开启 API
 *
 * 触发时机：进入 SSH 详情页的「能力」Tab 时自动探测一次。
 */
export function usePanelProbe(resourceId: string | null) {
  const [result, setResult] = useState<PanelProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastResourceId = useRef<string | null>(null);

  const probe = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await unwrapCommand(commands.sshPoolProbePanels(id));
      setResult(res);
      usePanelProbeStore.getState().setResult(id, res);
    } catch (e) {
      setError(formatIpcError(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 切换主机或首次进入时自动探测
  useEffect(() => {
    if (!resourceId) return;
    if (lastResourceId.current === resourceId && result) return;
    lastResourceId.current = resourceId;
    void probe(resourceId);
  }, [resourceId, result, probe]);

  const refresh = useCallback(() => {
    if (!resourceId) return;
    void probe(resourceId);
  }, [resourceId, probe]);

  return { result, loading, error, refresh };
}

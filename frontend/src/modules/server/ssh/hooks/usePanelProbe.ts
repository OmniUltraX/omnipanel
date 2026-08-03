import { useCallback, useEffect, useRef, useState } from "react";

import { commands, type PanelProbeResult } from "@/ipc/bindings";

/**
 * 面板（宝塔 / 1Panel）探测 hook。
 *
 * 与工具能力探测（useCapabilitiesStore）分开管理：
 * - 面板探测返回结构化数据（端口/入口/key/api状态），不适合塞进 ToolState
 * - 面板探测结果不跨 Tab 缓存（每次进入 SSH 详情页重新探测即可，后端 SSH exec 本身很快）
 * - API Key 属敏感凭据，探测到后由调用方直接写入 Vault（经 connSave），不在此 store 暴露
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
      const res = await commands.sshPoolProbePanels(id);
      setResult(res);
    } catch (e) {
      setError(String(e));
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

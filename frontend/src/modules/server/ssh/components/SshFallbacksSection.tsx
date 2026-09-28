import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "../../../../components/ui/form/Select";
import { WorkbenchActionButton } from "../../../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../../../i18n";
import { formatIpcError } from "../../../../ipc/result";
import { testWarpgateFallbackRoute } from "../../../../lib/warpgateConnect";
import type { SshFallbackRoute, SshPreferredRoute } from "../../panel/serverConnection";
import {
  listWarpgateSshTargets,
  loadWarpgateGateways,
  PLUGIN_ID_WARPGATE,
  type WarpgateGateway,
  type WarpgateSshTarget,
} from "../../../../lib/warpgateGateways";
import { showToast } from "../../../../stores/toastStore";
import { usePluginRuntimeStore } from "../../../../stores/pluginRuntimeStore";
import { WarpgateGatewaysDialog } from "./WarpgateGatewaysDialog";

type Props = {
  fallbacks: SshFallbackRoute[];
  preferredRoute: SshPreferredRoute;
  onFallbacksChange: (next: SshFallbackRoute[]) => void;
  onPreferredRouteChange: (next: SshPreferredRoute) => void;
};

function newFallbackId(): string {
  return `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

export function SshFallbacksSection({
  fallbacks,
  preferredRoute,
  onFallbacksChange,
  onPreferredRouteChange,
}: Props) {
  const { t } = useI18n();
  const ready = usePluginRuntimeStore((s) => {
    const item = s.items.find((entry) => entry.id === PLUGIN_ID_WARPGATE);
    return Boolean(item?.enabled && item?.activated);
  });
  const [gateways, setGateways] = useState<WarpgateGateway[]>([]);
  const [targetsByGw, setTargetsByGw] = useState<Record<string, WarpgateSshTarget[]>>({});
  const [loadingTargets, setLoadingTargets] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshGateways = useCallback(async () => {
    if (!ready) {
      setGateways([]);
      return;
    }
    try {
      setGateways(await loadWarpgateGateways());
    } catch (err) {
      setError(formatIpcError(err));
    }
  }, [ready]);

  useEffect(() => {
    void refreshGateways();
  }, [refreshGateways]);

  const loadTargets = useCallback(
    async (gatewayId: string) => {
      const gw = gateways.find((g) => g.id === gatewayId);
      if (!gw) return;
      setLoadingTargets(gatewayId);
      setError(null);
      try {
        const list = await listWarpgateSshTargets(gw);
        setTargetsByGw((prev) => ({ ...prev, [gatewayId]: list }));
      } catch (err) {
        setError(formatIpcError(err));
        setTargetsByGw((prev) => ({ ...prev, [gatewayId]: [] }));
      } finally {
        setLoadingTargets(null);
      }
    },
    [gateways],
  );

  // 已选网关（含回显/新增默认项）自动拉 Target，无需手动点「拉取列表」
  useEffect(() => {
    if (!ready || gateways.length === 0) return;
    const ids = [
      ...new Set(fallbacks.map((fb) => fb.gatewayId.trim()).filter(Boolean)),
    ];
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(targetsByGw, id)) continue;
      if (loadingTargets === id) continue;
      if (!gateways.some((g) => g.id === id)) continue;
      void loadTargets(id);
    }
  }, [ready, gateways, fallbacks, targetsByGw, loadingTargets, loadTargets]);

  const handleTestRoute = async (fb: SshFallbackRoute) => {
    if (!fb.gatewayId.trim() || !fb.targetId.trim()) {
      setError(t("ssh.warpgate.testRouteNeedTarget"));
      return;
    }
    setTestingId(fb.id);
    setError(null);
    try {
      const result = await testWarpgateFallbackRoute(fb);
      showToast(
        t("ssh.warpgate.testRouteOk", {
          user: result.user,
          host: `${result.host}:${result.port}`,
        }),
      );
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setTestingId(null);
    }
  };

  const preferredOptions = useMemo(() => {
    const opts = [
      { value: "auto", label: t("ssh.warpgate.routeAuto") },
      { value: "direct", label: t("ssh.warpgate.routeDirect") },
    ];
    for (const fb of fallbacks) {
      opts.push({
        value: fb.id,
        label: fb.label?.trim() || fb.targetName || fb.targetId,
      });
    }
    return opts;
  }, [fallbacks, t]);

  if (!ready) {
    return (
      <>
        <div className="form-section-title">{t("ssh.warpgate.fallbacksSection")}</div>
        <p className="form-hint">{t("ssh.warpgate.pluginRequired")}</p>
      </>
    );
  }

  return (
    <>
      <div className="form-section-title">{t("ssh.warpgate.fallbacksSection")}</div>
      <p className="form-hint">{t("ssh.warpgate.fallbacksHint")}</p>
      {error ? (
        <p className="form-hint" style={{ color: "var(--danger, #c44)" }}>
          {error}
        </p>
      ) : null}

      <div className="form-field">
        <label className="form-label">{t("ssh.warpgate.preferredRoute")}</label>
        <Select
          value={preferredRoute || "auto"}
          onChange={(value) => onPreferredRouteChange(value || "auto")}
          options={preferredOptions}
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <WorkbenchActionButton
          onClick={() => {
            const gatewayId = gateways[0]?.id ?? "";
            onFallbacksChange([
              ...fallbacks,
              {
                id: newFallbackId(),
                kind: "plugin",
                pluginId: PLUGIN_ID_WARPGATE,
                gatewayId,
                targetId: "",
                targetName: "",
                order: fallbacks.length,
              },
            ]);
          }}
        >
          {t("ssh.warpgate.addFallback")}
        </WorkbenchActionButton>
        <WorkbenchActionButton onClick={() => setManageOpen(true)}>
          {t("ssh.warpgate.manageGateways")}
        </WorkbenchActionButton>
      </div>

      {fallbacks.map((fb, index) => {
        const loading = loadingTargets === fb.gatewayId;
        const targets = targetsByGw[fb.gatewayId] ?? [];
        const targetOptions = loading
          ? [{ value: "", label: t("ssh.warpgate.loadingTargets") }]
          : [
              { value: "", label: t("ssh.warpgate.selectTarget") },
              ...targets.map((item) => ({
                value: item.id,
                label: item.name || item.id,
              })),
              ...(fb.targetId && !targets.some((item) => item.id === fb.targetId)
                ? [{ value: fb.targetId, label: fb.targetName || fb.targetId }]
                : []),
            ];
        return (
          <div
            key={fb.id}
            style={{
              border: "1px solid var(--border-subtle, #e5e7eb)",
              borderRadius: 4,
              padding: 8,
              marginBottom: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div className="form-row" style={{ alignItems: "flex-end" }}>
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("ssh.warpgate.gateway")}</label>
                <Select
                  value={fb.gatewayId}
                  onChange={(value) => {
                    onFallbacksChange(
                      fallbacks.map((item) =>
                        item.id === fb.id
                          ? { ...item, gatewayId: value, targetId: "", targetName: "", label: "" }
                          : item,
                      ),
                    );
                  }}
                  options={[
                    { value: "", label: t("ssh.warpgate.selectGateway") },
                    ...gateways.map((g) => ({ value: g.id, label: g.name || g.baseUrl })),
                  ]}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("ssh.warpgate.target")}</label>
                <Select
                  value={loading ? "" : fb.targetId}
                  onChange={(value) => {
                    const hit = targets.find((item) => item.id === value);
                    onFallbacksChange(
                      fallbacks.map((item) =>
                        item.id === fb.id
                          ? {
                              ...item,
                              targetId: value,
                              targetName: hit?.name || "",
                              label: hit?.name || item.label,
                            }
                          : item,
                      ),
                    );
                  }}
                  options={targetOptions}
                  disabled={!fb.gatewayId || loading}
                  style={{ width: "100%" }}
                />
              </div>
              <WorkbenchActionButton
                disabled={
                  !fb.gatewayId || !fb.targetId || testingId === fb.id || Boolean(testingId)
                }
                onClick={() => void handleTestRoute(fb)}
              >
                {testingId === fb.id ? t("ssh.warpgate.testing") : t("ssh.warpgate.test")}
              </WorkbenchActionButton>
              <WorkbenchActionButton
                danger
                disabled={Boolean(testingId)}
                onClick={() => onFallbacksChange(fallbacks.filter((_, i) => i !== index))}
              >
                {t("common.delete")}
              </WorkbenchActionButton>
            </div>
          </div>
        );
      })}

      <WarpgateGatewaysDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={() => {
          // 组件态清空后由 effect 再读本地缓存；被改过的网关已在 upsert/delete 时失效
          setTargetsByGw({});
          void refreshGateways();
        }}
      />
    </>
  );
}

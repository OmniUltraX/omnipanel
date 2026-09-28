import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { WorkbenchActionButton } from "../../../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../../../i18n";
import { formatIpcError } from "../../../../ipc/result";
import type { SshFallbackRoute, SshPreferredRoute } from "../../panel/serverConnection";
import {
  listWarpgateSshTargets,
  loadWarpgateGateways,
  PLUGIN_ID_WARPGATE,
  type WarpgateGateway,
  type WarpgateSshTarget,
} from "../../../../lib/warpgateGateways";
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
  const [manualTarget, setManualTarget] = useState<Record<string, string>>({});
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

  const loadTargets = async (gatewayId: string) => {
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
      {error ? <p className="form-hint" style={{ color: "var(--danger, #c44)" }}>{error}</p> : null}

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
            onFallbacksChange([
              ...fallbacks,
              {
                id: newFallbackId(),
                kind: "plugin",
                pluginId: PLUGIN_ID_WARPGATE,
                gatewayId: gateways[0]?.id ?? "",
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
        const targets = targetsByGw[fb.gatewayId] ?? [];
        const targetOptions = [
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
            <div className="form-row">
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("ssh.warpgate.gateway")}</label>
                <Select
                  value={fb.gatewayId}
                  onChange={(value) => {
                    const next = fallbacks.map((item) =>
                      item.id === fb.id
                        ? { ...item, gatewayId: value, targetId: "", targetName: "" }
                        : item,
                    );
                    onFallbacksChange(next);
                    if (value) void loadTargets(value);
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
                  value={fb.targetId}
                  onChange={(value) => {
                    const hit = targets.find((item) => item.id === value);
                    onFallbacksChange(
                      fallbacks.map((item) =>
                        item.id === fb.id
                          ? {
                              ...item,
                              targetId: value,
                              targetName: hit?.name || item.targetName,
                              label: hit?.name || item.label,
                            }
                          : item,
                      ),
                    );
                  }}
                  options={targetOptions}
                  disabled={!fb.gatewayId}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
            <div className="form-row" style={{ alignItems: "flex-end" }}>
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("ssh.warpgate.manualTarget")}</label>
                <TextInput
                  value={manualTarget[fb.id] ?? fb.targetName}
                  onChange={(value) => setManualTarget((prev) => ({ ...prev, [fb.id]: value }))}
                  placeholder={t("ssh.warpgate.manualTargetPlaceholder")}
                  onBlur={() => {
                    const name = (manualTarget[fb.id] ?? fb.targetName).trim();
                    if (!name) return;
                    onFallbacksChange(
                      fallbacks.map((item) =>
                        item.id === fb.id
                          ? {
                              ...item,
                              targetId: item.targetId || name,
                              targetName: name,
                              label: item.label || name,
                            }
                          : item,
                      ),
                    );
                  }}
                />
              </div>
              <WorkbenchActionButton
                disabled={!fb.gatewayId || loadingTargets === fb.gatewayId}
                onClick={() => void loadTargets(fb.gatewayId)}
              >
                {loadingTargets === fb.gatewayId
                  ? t("ssh.warpgate.loadingTargets")
                  : t("ssh.warpgate.refreshTargets")}
              </WorkbenchActionButton>
              <WorkbenchActionButton
                danger
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
        onChanged={() => void refreshGateways()}
      />
    </>
  );
}

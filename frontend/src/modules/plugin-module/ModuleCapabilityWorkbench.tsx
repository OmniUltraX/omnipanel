import { useEffect, useState } from "react";
import { getEnvLabel, useI18n } from "../../i18n";
import { connectionHostPort } from "./serviceConnections";
import type { Connection } from "../../ipc/bindings";
import type { ModuleCapabilityDecl } from "@omnipanel/plugin-sdk";
import { GenericCapabilityPane } from "./GenericCapabilityPane";
import { isProdEnvTag } from "../../lib/envTag";
import { invokeModuleMethod } from "./moduleInvoke";
import { type ModuleNamespaceRow } from "./useModuleNamespaces";

type NavKind = "overview" | string;

export function ModuleCapabilityWorkbench({
  pluginId,
  connection,
  capabilityId,
  namespaceId,
  namespaces: _namespaces,
  capabilities,
  capabilityLabel,
  onOpenCapability,
  onNamespacesReload,
  unauthWarning,
}: {
  pluginId: string;
  connection: Connection;
  capabilityId: NavKind;
  namespaceId: string;
  namespaces: ModuleNamespaceRow[];
  capabilities: ModuleCapabilityDecl[];
  capabilityLabel: (id: string) => string;
  onOpenCapability?: (capabilityId: string) => void;
  onNamespacesReload?: () => Promise<void>;
  unauthWarning?: boolean;
}) {
  if (capabilityId === "overview") {
    return (
      <OverviewPane
        pluginId={pluginId}
        connection={connection}
        namespaceId={namespaceId}
        capabilities={capabilities}
        capabilityLabel={capabilityLabel}
        onOpenCapability={onOpenCapability}
        unauthWarning={unauthWarning}
      />
    );
  }
  const declared = capabilities.find((cap) => cap.id === capabilityId);
  if (declared) {
    return (
      <GenericCapabilityPane
        pluginId={pluginId}
        connection={connection}
        capability={declared}
        namespaceId={namespaceId}
        onMutate={onNamespacesReload}
      />
    );
  }
  return <UnknownPane capabilityId={capabilityId} />;
}

function OverviewPane({
  pluginId,
  connection,
  namespaceId,
  capabilities,
  capabilityLabel,
  onOpenCapability,
  unauthWarning,
}: {
  pluginId: string;
  connection: Connection;
  namespaceId: string;
  capabilities: ModuleCapabilityDecl[];
  capabilityLabel: (id: string) => string;
  onOpenCapability?: (capabilityId: string) => void;
  unauthWarning?: boolean;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invokeModuleMethod<Record<string, unknown>>(pluginId, "getServerInfo", {}, { connection })
      .then((row) => {
        if (!cancelled) setInfo(row);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, connection]);
  const env = connection.envTag;
  const envText =
    env === "prod" || env === "staging" || env === "dev" || env === "local" || env === "unknown"
      ? getEnvLabel(env)
      : env;
  return (
    <div className="cloud-overview">
      <header className="db-tables-panel-header db-connection-info-header">
        <span className="db-tables-panel-header-label">{connection.name}</span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag">{envText}</span>
          <span className="db-tables-panel-header-tag">{connectionHostPort(connection) || "—"}</span>
          <span className="db-tables-panel-header-tag">
            {namespaceId || t("moduleHost.namespacePublic")}
          </span>
        </div>
      </header>
      <div className="cloud-overview__body">
        {unauthWarning || (isProdEnvTag(connection.envTag) && info?.auth === "none") ? (
          <p className="cloud-overview__test cloud-overview__test--err">{t("moduleHost.unauthProd")}</p>
        ) : null}
        {error ? <p className="cloud-overview__test cloud-overview__test--err">{error}</p> : null}
        <section className="cloud-overview__section">
          <h3 className="cloud-overview__title">{t("moduleHost.overview")}</h3>
          <div className="cloud-overview__facts">
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.dialect")}</span>
              <span className="cloud-overview__fact-value">{String(info?.dialect ?? "—")}</span>
            </div>
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.auth")}</span>
              <span className="cloud-overview__fact-value">{String(info?.auth ?? "—")}</span>
            </div>
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.version")}</span>
              <span className="cloud-overview__fact-value">{String(info?.version ?? "—")}</span>
            </div>
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.nodes")}</span>
              <span className="cloud-overview__fact-value">
                {String(info?.healthyNodes ?? "—")} / {String(info?.nodeCount ?? "—")}
              </span>
            </div>
          </div>
        </section>
        {capabilities.length > 0 ? (
          <section className="cloud-overview__section">
            <h3 className="cloud-overview__title">{t("moduleHost.capabilities")}</h3>
            <div className="cloud-overview__grid">
              {capabilities.map((cap) => (
                <button
                  key={cap.id}
                  type="button"
                  className="cloud-overview__card"
                  onClick={() => onOpenCapability?.(cap.id)}
                >
                  <span className="cloud-overview__card-label">{capabilityLabel(cap.id)}</span>
                  <strong className="cloud-overview__card-value">—</strong>
                  <span className="cloud-overview__card-hint">{t("moduleHost.openCapability")}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function UnknownPane({ capabilityId }: { capabilityId: string }) {
  const { t } = useI18n();
  return (
    <div className="cloud-resource-list">
      <div className="cloud-resource-list__empty">
        <p>{t("moduleHost.unknownCapability", { id: capabilityId })}</p>
      </div>
    </div>
  );
}

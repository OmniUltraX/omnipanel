import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { syncAndReconnectActiveAcpAgent } from "../../lib/acp/syncAgentConfig";
import {
  formatMcpTransportSummary,
  useMcpServicesStore,
  type McpServiceView,
} from "../../stores/mcpServicesStore";
import { AddMcpServiceDialog } from "./AddMcpServiceDialog";
import { McpServiceToolList } from "./McpServiceToolList";
import { Button } from "../ui/Button";
import { ModuleEmptyState } from "../ui/ModuleEmptyState";

export interface McpServicesSectionProps {
  /** 嵌入 Agent 卡片内时使用更紧凑的标题样式 */
  embedded?: boolean;
}

export function McpServicesSection({ embedded = false }: McpServicesSectionProps) {
  const { t } = useI18n();
  const services = useMcpServicesStore((s) => s.services);
  const loading = useMcpServicesStore((s) => s.loading);
  const storeError = useMcpServicesStore((s) => s.error);
  const refresh = useMcpServicesStore((s) => s.refresh);
  const upsertService = useMcpServicesStore((s) => s.upsertService);
  const removeService = useMcpServicesStore((s) => s.removeService);
  const setServiceRunning = useMcpServicesStore((s) => s.setServiceRunning);

  const [showDialog, setShowDialog] = useState(false);
  const [editingService, setEditingService] = useState<McpServiceView | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [toolRefreshTokens, setToolRefreshTokens] = useState<Record<string, number>>({});
  const [refreshingToolIds, setRefreshingToolIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const syncAgentMcpConfig = useCallback(() => {
    void syncAndReconnectActiveAcpAgent().catch(() => {});
  }, []);

  const openAddDialog = () => {
    setEditingService(null);
    setShowDialog(true);
  };

  const openEditDialog = (service: McpServiceView) => {
    if (service.builtin) return;
    setConfirmDeleteId(null);
    setEditingService(service);
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditingService(null);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToolsLoaded = useCallback((serviceId: string, count: number) => {
    setToolCounts((prev) => ({ ...prev, [serviceId]: count }));
    setRefreshingToolIds((prev) => {
      const next = new Set(prev);
      next.delete(serviceId);
      return next;
    });
  }, []);

  const handleRefreshTools = (serviceId: string) => {
    setRefreshingToolIds((prev) => new Set(prev).add(serviceId));
    setExpandedIds((prev) => new Set(prev).add(serviceId));
    setToolRefreshTokens((prev) => ({
      ...prev,
      [serviceId]: (prev[serviceId] ?? 0) + 1,
    }));
  };

  const handleToggleRunning = async (service: McpServiceView) => {
    const isRunning = service.status === "running";
    setTogglingId(service.id);
    try {
      await setServiceRunning(service.id, !isRunning);
      if (isRunning) {
        setToolCounts((prev) => {
          const next = { ...prev };
          delete next[service.id];
          return next;
        });
        setExpandedIds((prev) => {
          const next = new Set(prev);
          next.delete(service.id);
          return next;
        });
      } else {
        handleRefreshTools(service.id);
      }
      syncAgentMcpConfig();
    } finally {
      setTogglingId(null);
    }
  };

  const statusBadgeClass = (status: McpServiceView["status"]) =>
    `ai-model-row-standard ai-model-row-standard-${status === "running" ? "active" : "openai"}`;

  const renderServiceCard = (service: McpServiceView) => {
    const isConfirmingDelete = confirmDeleteId === service.id;
    const isRunning = service.status === "running";
    const canExpandTools = isRunning;
    const isExpanded = expandedIds.has(service.id);
    const toolCount = toolCounts[service.id];
    const isRefreshingTools = refreshingToolIds.has(service.id);
    const isToggling = togglingId === service.id;

    const runningToggleButton = (
      <Button
        variant="ghost"
        size="sm"
        className={`ai-model-row-activate${isRunning ? " is-active" : ""}`}
        disabled={isToggling}
        onClick={() => void handleToggleRunning(service)}
        title={
          isRunning ? t("settings.mcpServices.stopTitle") : t("settings.mcpServices.startTitle")
        }
        aria-label={
          isRunning ? t("settings.mcpServices.stopTitle") : t("settings.mcpServices.startTitle")
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 2v10" />
          <path d="M5.6 5.6a9 9 0 1012.8 0" />
        </svg>
      </Button>
    );

    const refreshToolsButton = canExpandTools ? (
      <Button
        variant="ghost"
        size="sm"
        className="ai-model-row-refresh"
        disabled={isRefreshingTools}
        onClick={() => handleRefreshTools(service.id)}
        title={t("settings.mcpServices.refreshTools")}
        aria-label={t("settings.mcpServices.refreshTools")}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="14"
          height="14"
          className={isRefreshingTools ? "icon-spin" : undefined}
        >
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
      </Button>
    ) : null;

    return (
      <li
        key={service.id}
        className={`ai-provider-card${isRunning ? " ai-provider-card--active" : ""}`}
      >
        <div className="ai-provider-header">
          <div className="ai-provider-header-main">
            {canExpandTools ? (
              <button
                type="button"
                className="ai-provider-expand"
                aria-expanded={isExpanded}
                aria-label={t("settings.mcpServices.toggleTools")}
                onClick={() => toggleExpanded(service.id)}
              >
                {isExpanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="ai-provider-expand-placeholder" aria-hidden />
            )}
            <div className="ai-provider-summary">
              <div className="ai-provider-title-row">
                <span className="ai-provider-name">{service.name}</span>
                {service.builtin ? (
                  <span className="ai-model-row-standard ai-model-row-standard-active">
                    {t("settings.mcpServices.builtinBadge")}
                  </span>
                ) : (
                  <span className="ai-model-row-standard ai-model-row-standard-openai">
                    {service.transport.kind === "stdio"
                      ? t("settings.mcpServices.transportStdio")
                      : t("settings.mcpServices.transportSse")}
                  </span>
                )}
                <span className={statusBadgeClass(service.status)}>
                  {t(`settings.mcpServices.status.${service.status}`)}
                </span>
                {canExpandTools && toolCount !== undefined ? (
                  <span className="ai-provider-model-count">
                    {t("settings.mcpServices.toolCount", { count: toolCount })}
                  </span>
                ) : canExpandTools ? (
                  <span className="ai-provider-single-model">
                    {t("settings.mcpServices.toolsUnknown")}
                  </span>
                ) : null}
              </div>
              <div className="ai-model-row-meta">
                <span className="ai-model-row-baseurl" title={formatMcpTransportSummary(service)}>
                  {formatMcpTransportSummary(service) ||
                    (service.builtin ? t("settings.mcpServices.endpointPending") : "")}
                </span>
                {service.errorMessage ? (
                  <>
                    <span className="ai-model-row-sep">·</span>
                    <span style={{ color: "var(--danger)" }}>{service.errorMessage}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="ai-model-row-actions">
            {service.builtin ? (
              <>
                {refreshToolsButton}
                {runningToggleButton}
              </>
            ) : isConfirmingDelete ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void removeService(service.id).then(() => {
                      syncAgentMcpConfig();
                    });
                    setConfirmDeleteId(null);
                  }}
                >
                  {t("settings.mcpServices.confirmDelete")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>
                  {t("settings.mcpServices.cancelDelete")}
                </Button>
              </>
            ) : (
              <>
                {runningToggleButton}
                {refreshToolsButton}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ai-model-row-edit"
                  onClick={() => openEditDialog(service)}
                  title={t("settings.mcpServices.editBtn")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ai-model-row-delete"
                  onClick={() => setConfirmDeleteId(service.id)}
                  title={t("settings.mcpServices.deleteBtn")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                  </svg>
                </Button>
              </>
            )}
          </div>
        </div>

        {canExpandTools && isExpanded ? (
          <McpServiceToolList
            serviceId={service.id}
            refreshToken={toolRefreshTokens[service.id] ?? 0}
            onToolsLoaded={handleToolsLoaded}
          />
        ) : null}
      </li>
    );
  };

  return (
    <div className={embedded ? "settings-section settings-section--embedded" : "settings-section"}>
      <div className="settings-section-header">
        <div>
          {embedded ? (
            <h3 className="settings-subsection-title">{t("settings.mcpServices.title")}</h3>
          ) : (
            <h2>{t("settings.mcpServices.title")}</h2>
          )}
          <p className="section-desc">
            {embedded
              ? t("settings.acpServices.mcpEmbeddedDesc")
              : t("settings.mcpServices.description")}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          className="ai-models-add-btn"
          onClick={openAddDialog}
          title={t("settings.mcpServices.add.title")}
          aria-label={t("settings.mcpServices.add.title")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>{t("settings.mcpServices.add.title")}</span>
        </Button>
      </div>

      {storeError && (
        <div className="ai-provider-refresh-notice ai-provider-refresh-notice--err">
          {storeError}
        </div>
      )}

      {loading && services.length === 0 ? (
        <div className="ai-models-empty">
          <ModuleEmptyState preset="inbox" title={t("settings.mcpServices.loading")} desc="" />
        </div>
      ) : (
        <ul className="ai-models-list">
          {services.map(renderServiceCard)}
        </ul>
      )}

      <AddMcpServiceDialog
        open={showDialog}
        onClose={closeDialog}
        editService={editingService}
        onSubmit={upsertService}
        onSaved={(serviceId) => {
          setExpandedIds((prev) => new Set(prev).add(serviceId));
          syncAgentMcpConfig();
        }}
      />
    </div>
  );
}

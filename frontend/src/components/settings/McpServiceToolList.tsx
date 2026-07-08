import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/primitives/Button";
import { useI18n } from "../../i18n";
import { TextInput } from "../ui/form/TextInput";
import { commands, type ToolInfo } from "../../ipc/bindings";
import { OMNIMCP_BUILTIN_SERVICE_ID } from "../../lib/ai/context/moduleBuiltinCatalog";
import {
  initBuiltinToolStore,
  isBuiltinToolExternalExposed,
} from "../../stores/builtinToolStore";
import { fuzzyMatchModelName } from "../../lib/fetchProviderModels";

const PAGE_SIZE = 15;

interface McpServiceToolListProps {
  serviceId: string;
  refreshToken?: number;
  onToolsLoaded?: (serviceId: string, count: number) => void;
}

export function McpServiceToolList({
  serviceId,
  refreshToken = 0,
  onToolsLoaded,
}: McpServiceToolListProps) {
  const { t } = useI18n();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const onToolsLoadedRef = useRef(onToolsLoaded);
  onToolsLoadedRef.current = onToolsLoaded;

  const loadTools = useCallback(async () => {
    const hasCachedTools = toolsRef.current.length > 0;
    if (!hasCachedTools) {
      setLoading(true);
    }
    setError(null);
    try {
      if (serviceId === OMNIMCP_BUILTIN_SERVICE_ID) {
        await initBuiltinToolStore();
      }
      const result = await commands.mcpListServiceTools(serviceId);
      if (result.status === "ok") {
        let list = result.data;
        if (serviceId === OMNIMCP_BUILTIN_SERVICE_ID) {
          list = list.filter((tool) => isBuiltinToolExternalExposed(tool.name));
        }
        setTools(list);
        onToolsLoadedRef.current?.(serviceId, list.length);
      } else {
        setTools([]);
        onToolsLoadedRef.current?.(serviceId, 0);
        setError(result.error ?? t("settings.mcpServices.toolList.loadFailed"));
      }
    } catch (e) {
      if (!hasCachedTools) {
        setTools([]);
      }
      onToolsLoadedRef.current?.(serviceId, 0);
      setError(e instanceof Error ? e.message : t("settings.mcpServices.toolList.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [serviceId, t]);

  useEffect(() => {
    void loadTools();
  }, [loadTools, refreshToken]);

  const filtered = useMemo(
    () =>
      tools.filter(
        (tool) =>
          fuzzyMatchModelName(tool.name, search) ||
          fuzzyMatchModelName(tool.description ?? "", search),
      ),
    [tools, search],
  );

  useEffect(() => {
    setPage(0);
  }, [search, serviceId, tools.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  if (loading && tools.length === 0 && !error) {
    return (
      <div className="ai-provider-models-panel">
        <div className="ai-provider-models-empty">{t("settings.mcpServices.toolList.loading")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ai-provider-models-panel">
        <div className="ai-provider-refresh-notice ai-provider-refresh-notice--err">{error}</div>
        <Button variant="ghost" size="sm" onClick={() => void loadTools()}>
          {t("settings.mcpServices.toolList.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="ai-provider-models-panel">
      <div className="ai-provider-models-toolbar">
        <TextInput
          className="input input-search ai-provider-models-search"
          value={search}
          onChange={setSearch}
          copyable={false}
          placeholder={t("settings.mcpServices.toolList.searchPlaceholder")}
        />
      </div>

      <div className="ai-provider-models-summary">
        {t("settings.mcpServices.toolList.summary", {
          total: tools.length,
          filtered: search.trim() ? filtered.length : tools.length,
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="ai-provider-models-empty">
          {tools.length === 0
            ? t("settings.mcpServices.toolList.empty")
            : t("settings.mcpServices.toolList.noMatch")}
        </div>
      ) : (
        <>
          <ul className="ai-provider-models">
            {pageItems.map((tool) => (
              <li key={tool.name} className="ai-provider-model-item ai-provider-model-item--readonly">
                <div className="ai-provider-model-item-main">
                  <span className="ai-provider-model-name" title={tool.name}>
                    {tool.name}
                  </span>
                  {tool.description ? (
                    <span className="ai-provider-model-desc" title={tool.description}>
                      {tool.description}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="ai-provider-models-pagination">
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t("settings.mcpServices.toolList.prevPage")}
              </Button>
              <span className="ai-provider-models-page-info">
                {t("settings.mcpServices.toolList.pageInfo", {
                  page: safePage + 1,
                  total: totalPages,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                {t("settings.mcpServices.toolList.nextPage")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { commands, type LocalRuntimeProbeResult } from "../../ipc/bindings";
import {
  formatBytes,
  linkCustomLocalEndpoint,
  linkLmStudioToAiConfig,
  linkOllamaToAiConfig,
} from "../../lib/localRuntime";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { appConfirm } from "../../lib/appConfirm";
import { unwrapCommand } from "../../ipc/result";
import {
  useBackgroundTaskStore,
  type BackgroundTaskInfo,
} from "../../stores/backgroundTaskStore";
import { Button } from "../ui/primitives/Button";
import { TextInput } from "../ui/form/TextInput";

function statusTone(status: string): string {
  switch (status) {
    case "running":
      return "local-runtime-badge local-runtime-badge--ok";
    case "installed_not_running":
      return "local-runtime-badge local-runtime-badge--warn";
    default:
      return "local-runtime-badge local-runtime-badge--muted";
  }
}

function isLocalModelsTask(task: BackgroundTaskInfo): boolean {
  return task.module === "localModels" || task.kind === "ollamaInstall" || task.kind === "ollamaPull";
}

function taskPercent(task: BackgroundTaskInfo): number | null {
  if (task.total > 0) {
    return Math.min(100, Math.max(0, Math.round((task.index / task.total) * 100)));
  }
  return null;
}

function taskStatusText(
  t: (key: string, params?: Record<string, string | number>) => string,
  status: BackgroundTaskInfo["status"],
): string {
  switch (status) {
    case "pending":
      return t("shell.backgroundTasks.statusPending");
    case "running":
      return t("shell.backgroundTasks.statusRunning");
    case "completed":
      return t("shell.backgroundTasks.statusCompleted");
    case "failed":
      return t("shell.backgroundTasks.statusFailed");
    case "cancelled":
      return t("shell.backgroundTasks.statusCancelled");
    default:
      return status;
  }
}

export function LocalModelsSection() {
  const { t } = useI18n();
  const [probe, setProbe] = useState<LocalRuntimeProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [customBaseUrl, setCustomBaseUrl] = useState("http://127.0.0.1:8080/v1");
  const [customName, setCustomName] = useState("Local OpenAI");
  const [customModelName, setCustomModelName] = useState("");

  const [refreshingCatalog, setRefreshingCatalog] = useState(false);

  const tasks = useBackgroundTaskStore((s) => s.tasks);
  const setTaskListOpen = useBackgroundTaskStore((s) => s.setTaskListOpen);
  const handledDoneRef = useRef<Set<string>>(new Set());

  const localTasks = useMemo(
    () =>
      Object.values(tasks)
        .filter(isLocalModelsTask)
        .sort((a, b) => a.startedAt - b.startedAt),
    [tasks],
  );
  const activeLocalTasks = useMemo(
    () => localTasks.filter((t) => t.status === "pending" || t.status === "running"),
    [localTasks],
  );
  const installing = activeLocalTasks.some((t) => t.kind === "ollamaInstall");
  const pullingModels = useMemo(
    () =>
      new Set(
        activeLocalTasks
          .filter((t) => t.kind === "ollamaPull")
          .map((t) => {
            const m = t.title.match(/：(.+)$/);
            return m?.[1]?.trim() ?? "";
          })
          .filter(Boolean),
      ),
    [activeLocalTasks],
  );

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) {
      setError(t("settings.localModels.needTauri"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await commands.localRuntimeProbe();
      if (res.status !== "ok") {
        setError(typeof res.error === "string" ? res.error : String(res.error));
        setProbe(null);
        return;
      }
      setProbe(res.data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const refreshCatalog = useCallback(async () => {
    if (!isTauriRuntime()) {
      setError(t("settings.localModels.needTauri"));
      return;
    }
    setRefreshingCatalog(true);
    setError(null);
    try {
      const res = await commands.localRuntimeRefreshCatalog();
      if (res.status !== "ok") {
        setError(typeof res.error === "string" ? res.error : String(res.error));
        return;
      }
      setProbe(res.data);
      setInfo(t("settings.localModels.catalogSource", { source: res.data.catalogSource }));
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshingCatalog(false);
    }
  }, [t]);

  const recommendedByScenario = useMemo(() => {
    const groups: Record<string, NonNullable<LocalRuntimeProbeResult["recommendedModels"]>> = {
      coding: [],
      chinese_chat: [],
      embedding: [],
    };
    for (const m of probe?.recommendedModels ?? []) {
      const key = m.scenario in groups ? m.scenario : "chinese_chat";
      groups[key].push(m);
    }
    return groups;
  }, [probe?.recommendedModels]);

  useEffect(() => {
    void refresh();
    void useBackgroundTaskStore.getState().refreshRunning();
  }, [refresh]);

  // 后台任务完成/失败时刷新探测，并同步 Provider（离开设置页再回来也能接上）
  useEffect(() => {
    for (const task of localTasks) {
      if (
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.status !== "cancelled"
      ) {
        continue;
      }
      if (handledDoneRef.current.has(task.id)) continue;
      handledDoneRef.current.add(task.id);

      if (task.status === "completed") {
        setInfo(task.progress.trim() || task.title);
        void (async () => {
          await refresh();
          if (task.kind === "ollamaPull") {
            await linkOllamaToAiConfig();
          }
        })();
      } else if (task.status === "failed") {
        setError(task.error?.trim() || task.title);
      }
    }
  }, [localTasks, refresh]);

  const handleLinkOllama = async () => {
    setBusy("link");
    setError(null);
    setInfo(null);
    try {
      const result = await linkOllamaToAiConfig(probe);
      if (!result.ok) {
        setError(t(`settings.localModels.errors.${result.error}`));
        return;
      }
      setInfo(t("settings.localModels.linkOllamaDone", { count: result.modelCount }));
    } finally {
      setBusy(null);
    }
  };

  const handleStart = async () => {
    setBusy("start");
    setError(null);
    try {
      const res = await commands.localRuntimeStartOllama();
      if (res.status !== "ok") {
        setError(typeof res.error === "string" ? res.error : String(res.error));
        return;
      }
      await refresh();
      setInfo(t("settings.localModels.startDone"));
    } finally {
      setBusy(null);
    }
  };

  const handleInstall = async () => {
    const ok = await appConfirm(
      t("settings.localModels.installConfirmBody"),
      t("settings.localModels.installConfirmTitle"),
      { confirmLabel: t("settings.localModels.installConfirmAction"), kind: "warning" },
    );
    if (!ok) return;
    setError(null);
    setInfo(t("settings.localModels.taskSubmitted"));
    try {
      await unwrapCommand(commands.bgTaskSubmitOllamaInstall());
      setTaskListOpen(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePull = async (model: string) => {
    const name = model.trim();
    if (!name) {
      setError(t("settings.localModels.customPullEmpty"));
      return;
    }
    setError(null);
    setInfo(t("settings.localModels.taskSubmitted"));
    try {
      await unwrapCommand(commands.bgTaskSubmitOllamaPull(name));
      setTaskListOpen(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCustomPull = async () => {
    const name = customModelName.trim();
    if (!name) {
      setError(t("settings.localModels.customPullEmpty"));
      return;
    }
    await handlePull(name);
    setCustomModelName("");
  };

  const handleDelete = async (model: string) => {
    const ok = await appConfirm(
      t("settings.localModels.deleteConfirmBody", { model }),
      t("settings.localModels.deleteConfirmTitle"),
      { confirmLabel: t("settings.localModels.deleteConfirmAction"), kind: "warning" },
    );
    if (!ok) return;
    setBusy(`del:${model}`);
    setError(null);
    try {
      const res = await commands.localRuntimeOllamaDelete(model);
      if (res.status !== "ok") {
        setError(typeof res.error === "string" ? res.error : String(res.error));
        return;
      }
      await refresh();
      await linkOllamaToAiConfig();
      setInfo(t("settings.localModels.deleteDone", { model }));
    } finally {
      setBusy(null);
    }
  };

  const handleLinkLmStudio = async () => {
    setBusy("lms");
    setError(null);
    try {
      const result = await linkLmStudioToAiConfig(probe);
      if (!result.ok) {
        setError(t("settings.localModels.errors.lms_unreachable"));
        return;
      }
      setInfo(t("settings.localModels.linkLmsDone", { count: result.modelCount }));
    } finally {
      setBusy(null);
    }
  };

  const handleLinkCustom = async () => {
    setBusy("custom");
    setError(null);
    try {
      const res = await commands.localRuntimeProbeOpenaiCompat(customBaseUrl.trim());
      if (res.status !== "ok") {
        setError(typeof res.error === "string" ? res.error : String(res.error));
        return;
      }
      if (!res.data.reachable) {
        setError(res.data.error || t("settings.localModels.errors.custom_unreachable"));
        return;
      }
      const id = `local-custom-${Date.now()}`;
      linkCustomLocalEndpoint(
        id,
        customName.trim() || "Local OpenAI",
        customBaseUrl.trim(),
        res.data.models,
      );
      setInfo(t("settings.localModels.linkCustomDone", { count: res.data.models.length }));
    } finally {
      setBusy(null);
    }
  };

  const openManualDownload = async () => {
    const res = await commands.localRuntimeOllamaDownloadUrl();
    const url = res.status === "ok" ? res.data : "https://ollama.com/download";
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const ollamaStatus = probe?.ollama.status ?? "not_installed";
  const actionsDisabled = busy !== null || installing || pullingModels.size > 0;

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.localModels.title")}</h2>
          <p className="section-desc">{t("settings.localModels.desc")}</p>
        </div>
        <div className="settings-section-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || refreshingCatalog || actionsDisabled}
            onClick={() => void refresh()}
          >
            {loading ? t("settings.localModels.probing") : t("settings.localModels.probe")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || refreshingCatalog || actionsDisabled}
            onClick={() => void refreshCatalog()}
          >
            {refreshingCatalog
              ? t("settings.localModels.refreshingCatalog")
              : t("settings.localModels.refreshCatalog")}
          </Button>
        </div>
      </div>

      {error ? <p className="setting-hint setting-hint--error">{error}</p> : null}
      {info ? <p className="setting-hint">{info}</p> : null}

      {localTasks.length > 0 ? (
        <div className="local-runtime-task-panel">
          <div className="local-runtime-task-panel__header">
            <h4>{t("settings.localModels.bgTasks")}</h4>
            <Button variant="ghost" size="sm" onClick={() => setTaskListOpen(true)}>
              {t("settings.localModels.openBgTasks")}
            </Button>
          </div>
          <ul className="local-runtime-task-list">
            {localTasks.map((task) => {
              const pct = taskPercent(task);
              return (
                <li key={task.id} className="local-runtime-task-row">
                  <div className="local-runtime-task-row__main">
                    <span className="local-runtime-model-name">{task.title}</span>
                    <span className="setting-hint">
                      {task.progress.trim() || taskStatusText(t, task.status)}
                    </span>
                  </div>
                  {pct != null ? (
                    <div className="local-runtime-progress">
                      <div className="local-runtime-progress__track">
                        <div
                          className="local-runtime-progress__fill"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="setting-hint">{pct}%</span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="local-runtime-card">
        <div className="local-runtime-card__header">
          <h3>Ollama</h3>
          <span className={statusTone(ollamaStatus)}>
            {t(`settings.localModels.status.${ollamaStatus}`)}
          </span>
        </div>
        <p className="setting-hint">
          {t("settings.localModels.ollamaEndpoint", {
            endpoint: probe?.ollama.endpoint ?? "http://127.0.0.1:11434",
          })}
          {probe?.ollama.version
            ? ` · ${t("settings.localModels.version", { version: probe.ollama.version })}`
            : ""}
        </p>
        {probe ? (
          <>
            <p className="setting-hint">
              {t("settings.localModels.hardware", {
                memory: Math.round((probe.hardware?.totalMemoryMb ?? probe.totalMemoryMb) / 1024),
                tier: t(`settings.localModels.tier.${probe.hardwareTier}`),
              })}
            </p>
            {probe.hardware ? (
              <p className="setting-hint">
                {t("settings.localModels.hardwareDetail", {
                  gpu: probe.hardware.gpuName || t("settings.localModels.hardwareGpuUnknown"),
                  vram:
                    probe.hardware.vramMb > 0
                      ? `${Math.round(probe.hardware.vramMb / 1024)} GB`
                      : t("settings.localModels.hardwareVramUnknown"),
                  discrete: probe.hardware.hasDiscreteGpu
                    ? t("settings.localModels.hardwareDiscreteYes")
                    : t("settings.localModels.hardwareDiscreteNo"),
                  quant: probe.hardware.quantPref,
                  maxB: Math.max(1, Math.round(probe.hardware.maxParamB)),
                })}
              </p>
            ) : null}
            {probe.catalogSource ? (
              <p className="setting-hint">
                {t("settings.localModels.catalogSource", { source: probe.catalogSource })}
              </p>
            ) : null}
          </>
        ) : null}

        <div className="local-runtime-actions">
          {ollamaStatus === "not_installed" ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={actionsDisabled}
                onClick={() => void handleInstall()}
              >
                {installing
                  ? t("settings.localModels.installing")
                  : t("settings.localModels.install")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void openManualDownload()}>
                {t("settings.localModels.manualDownload")}
              </Button>
            </>
          ) : null}
          {ollamaStatus === "installed_not_running" ? (
            <Button
              variant="primary"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => void handleStart()}
            >
              {busy === "start" ? t("settings.localModels.starting") : t("settings.localModels.start")}
            </Button>
          ) : null}
          {ollamaStatus === "running" ? (
            <Button
              variant="primary"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => void handleLinkOllama()}
            >
              {busy === "link"
                ? t("settings.localModels.linking")
                : t("settings.localModels.linkOllama")}
            </Button>
          ) : null}
        </div>

        {probe && ollamaStatus === "running" ? (
          <div className="local-runtime-models">
            <h4>{t("settings.localModels.installedModels")}</h4>
            {probe.ollama.models.length === 0 ? (
              <p className="setting-hint">{t("settings.localModels.noModels")}</p>
            ) : (
              <ul className="local-runtime-model-list">
                {probe.ollama.models.map((m) => (
                  <li key={m.name} className="local-runtime-model-row">
                    <span className="local-runtime-model-name">{m.name}</span>
                    <span className="setting-hint">{formatBytes(m.sizeBytes)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={actionsDisabled}
                      onClick={() => void handleDelete(m.name)}
                    >
                      {t("settings.localModels.delete")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {probe?.recommendedModels?.length ? (
        <div className="local-runtime-card">
          <h3>{t("settings.localModels.recommended")}</h3>
          <p className="setting-hint">{t("settings.localModels.recommendedHint")}</p>
          <div className="local-runtime-scenario-grid">
            {(["coding", "chinese_chat", "embedding"] as const).map((scenario) => {
              const models = recommendedByScenario[scenario] ?? [];
              if (models.length === 0) return null;
              return (
                <div key={scenario} className="local-runtime-scenario">
                  <h4>{t(`settings.localModels.scenario.${scenario}`)}</h4>
                  <ul className="local-runtime-model-list">
                    {models.map((m) => {
                      const installed = probe.ollama.models.some(
                        (x) =>
                          x.name === m.name ||
                          x.name.startsWith(`${m.name}:`) ||
                          m.name.startsWith(`${x.name}:`),
                      );
                      const pulling = pullingModels.has(m.name);
                      return (
                        <li key={`${scenario}-${m.name}`} className="local-runtime-model-row">
                          <div>
                            <div className="local-runtime-model-name">{m.name}</div>
                            <div className="setting-hint">
                              {m.description} · ~{m.approxSizeGb} GB
                              {m.quantHint
                                ? ` · ${t("settings.localModels.quantHint", { hint: m.quantHint })}`
                                : ""}
                            </div>
                          </div>
                          {ollamaStatus === "running" ? (
                            installed ? (
                              <span className="local-runtime-badge local-runtime-badge--ok">
                                {t("settings.localModels.installed")}
                              </span>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={actionsDisabled}
                                onClick={() => void handlePull(m.name)}
                              >
                                {pulling
                                  ? t("settings.localModels.pullingShort")
                                  : t("settings.localModels.pull")}
                              </Button>
                            )
                          ) : (
                            <span className="setting-hint">
                              {t("settings.localModels.needRunning")}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="local-runtime-card">
        <h3>{t("settings.localModels.customPullTitle")}</h3>
        <p className="setting-hint">{t("settings.localModels.customPullHint")}</p>
        <div className="local-runtime-custom-pull">
          <TextInput
            value={customModelName}
            onChange={setCustomModelName}
            placeholder={t("settings.localModels.customPullPlaceholder")}
            disabled={ollamaStatus !== "running" || actionsDisabled}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCustomPull();
              }
            }}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={ollamaStatus !== "running" || actionsDisabled || !customModelName.trim()}
            onClick={() => void handleCustomPull()}
          >
            {t("settings.localModels.pull")}
          </Button>
        </div>
        {ollamaStatus !== "running" ? (
          <p className="setting-hint">{t("settings.localModels.needRunning")}</p>
        ) : null}
      </div>

      <div className="local-runtime-card">
        <div className="local-runtime-card__header">
          <h3>LM Studio</h3>
          <span
            className={
              probe?.lmStudio.reachable
                ? "local-runtime-badge local-runtime-badge--ok"
                : "local-runtime-badge local-runtime-badge--muted"
            }
          >
            {probe?.lmStudio.reachable
              ? t("settings.localModels.lmsOnline")
              : t("settings.localModels.lmsOffline")}
          </span>
        </div>
        <p className="setting-hint">{t("settings.localModels.lmsHint")}</p>
        {probe?.lmStudio.reachable ? (
          <>
            <p className="setting-hint">
              {t("settings.localModels.lmsModels", { count: probe.lmStudio.models.length })}
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => void handleLinkLmStudio()}
            >
              {t("settings.localModels.linkLms")}
            </Button>
          </>
        ) : null}
      </div>

      <div className="local-runtime-card">
        <h3>{t("settings.localModels.customTitle")}</h3>
        <p className="setting-hint">{t("settings.localModels.customHint")}</p>
        <div className="form-field">
          <label>{t("settings.localModels.customName")}</label>
          <TextInput value={customName} onChange={setCustomName} />
        </div>
        <div className="form-field">
          <label>{t("settings.localModels.customBaseUrl")}</label>
          <TextInput value={customBaseUrl} onChange={setCustomBaseUrl} />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={actionsDisabled}
          onClick={() => void handleLinkCustom()}
        >
          {t("settings.localModels.linkCustom")}
        </Button>
      </div>
    </div>
  );
}

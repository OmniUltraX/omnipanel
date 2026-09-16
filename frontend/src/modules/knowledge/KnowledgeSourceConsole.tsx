import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import {
  commands,
  type KsReport,
  type KsSourceDecl,
  type KsSourceField,
  type KsStatus,
  type KsTestResult,
  type PluginListItem,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import {
  scheduleClientModuleSync,
  useClientSyncTombstoneStore,
} from "../clientSync";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";

type SourceState = {
  pluginId: string;
  decl: KsSourceDecl;
  values: Record<string, string>;
  secrets: Record<string, string>;
  secretsSaved: Record<string, boolean>;
  status: KsStatus | null;
  busy: null | "save" | "test" | "sync" | "rebuild";
  message: string;
  testResult: KsTestResult | null;
};

function fillText(
  template: string,
  vars: Record<string, string | number>,
): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

function formatTime(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function renderFieldInput(
  key: string,
  field: KsSourceField,
  value: string,
  saved: boolean,
  disabled: boolean,
  saveLabel: string,
  onChange: (value: string) => void,
) {
  if (field.kind === "checkbox") {
    return (
      <label key={key} className="knowledge-siyuan-dialog__row">
        <input
          type="checkbox"
          checked={value === "true"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        {field.label || field.key}
      </label>
    );
  }
  if (field.kind === "secret") {
    return (
      <div key={key} className="knowledge-siyuan-dialog__field">
        <span>
          {field.label || field.key}
          {saved ? `（${saveLabel}）` : ""}
        </span>
        <input
          type="password"
          className="knowledge-siyuan-dialog__input"
          value={value}
          disabled={disabled}
          placeholder={field.placeholder || field.label}
          autoComplete="new-password"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  return (
    <div key={key} className="knowledge-siyuan-dialog__field">
      <span>{field.label || field.key}</span>
      <input
        className="knowledge-siyuan-dialog__input"
        value={value}
        disabled={disabled}
        placeholder={field.placeholder || field.key}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function KnowledgeSourceConsole({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const loadEntries = useKnowledgeStore((s) => s.loadEntries);
  const [sources, setSources] = useState<SourceState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const patchSource = useCallback(
    (pluginId: string, sourceId: string, part: Partial<SourceState>) => {
      setSources((prev) =>
        prev.map((item) =>
          item.pluginId === pluginId && item.decl.sourceId === sourceId
            ? { ...item, ...part }
            : item,
        ),
      );
    },
    [],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await unwrapCommand(commands.pluginList());
      const knowledge: PluginListItem[] = list.filter((item) => item.kind === "knowledge");
      const next: SourceState[] = [];
      for (const plugin of knowledge) {
        let decls: KsSourceDecl[] = [];
        try {
          decls = await unwrapCommand(commands.ksSourcesOf(plugin.id));
        } catch {
          continue;
        }
        for (const decl of decls) {
          const values: Record<string, string> = {};
          const secretsSaved: Record<string, boolean> = {};
          try {
            const cfg = await unwrapCommand(
              commands.ksConfigGet(plugin.id, decl.sourceId),
            );
            if (cfg) {
              try {
                const parsed = JSON.parse(cfg.configJson || "{}") as Record<string, unknown>;
                for (const [key, value] of Object.entries(parsed)) {
                  if (
                    typeof value === "string" ||
                    typeof value === "number" ||
                    typeof value === "boolean"
                  ) {
                    values[key] = String(value);
                  }
                }
              } catch {
                // 坏配置当空处理
              }
              for (const field of decl.fields) {
                if (field.kind !== "secret") continue;
                try {
                  secretsSaved[field.key] = await unwrapCommand(
                    commands.ksSecretHas(plugin.id, decl.sourceId, field.key),
                  );
                } catch {
                  secretsSaved[field.key] = false;
                }
              }
            }
          } catch {
            // 无配置：空表单
          }
          let status: KsStatus | null = null;
          try {
            status = await unwrapCommand(commands.ksStatus(plugin.id, decl.sourceId));
          } catch {
            status = null;
          }
          next.push({
            pluginId: plugin.id,
            decl,
            values,
            secrets: {},
            secretsSaved,
            status,
            busy: null,
            message: "",
            testResult: null,
          });
        }
      }
      // 原生思源配置自动播种：ks 无配置且原生有工作空间路径时，一键沿用。
      await autoSeedFromNative(next);
      setSources(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const setFieldValue = (
    pluginId: string,
    sourceId: string,
    key: string,
    value: string,
    secret: boolean,
  ) => {
    setSources((prev) =>
      prev.map((item) => {
        if (item.pluginId !== pluginId || item.decl.sourceId !== sourceId) return item;
        if (secret) {
          return {
            ...item,
            secrets: { ...item.secrets, [key]: value },
            secretsSaved: { ...item.secretsSaved, [key]: false },
          };
        }
        return { ...item, values: { ...item.values, [key]: value } };
      }),
    );
  };

  const handleSave = async (item: SourceState) => {
    const { pluginId } = item;
    const sourceId = item.decl.sourceId;
    patchSource(pluginId, sourceId, { busy: "save", message: "" });
    try {
      await unwrapCommand(
        commands.ksConfigSave(
          pluginId,
          sourceId,
          item.decl.title || sourceId,
          JSON.stringify(item.values),
        ),
      );
      for (const field of item.decl.fields) {
        if (field.kind !== "secret") continue;
        const fresh = (item.secrets[field.key] ?? "").trim();
        if (!fresh) continue;
        await unwrapCommand(commands.ksSecretSave(pluginId, sourceId, field.key, fresh));
      }
      patchSource(pluginId, sourceId, { message: t("knowledge.ks.saved") });
      await reload();
    } catch (err) {
      patchSource(pluginId, sourceId, {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      patchSource(pluginId, sourceId, { busy: null });
    }
  };

  const finishReport = (
    pluginId: string,
    sourceId: string,
    namespace: string,
    report: KsReport,
  ) => {
    patchSource(pluginId, sourceId, {
      status: { lastSyncAt: report.finishedAtMs, report },
      message: fillText(t("knowledge.ks.syncDone"), {
        added: report.added,
        updated: report.updated,
        archived: report.archived,
        failed: report.failed.length,
      }),
    });
    // 陈旧墓碑会继续杀复活：按条目前缀清理；再推云端快照，否则下次启动拉取对齐删除。
    useClientSyncTombstoneStore
      .getState()
      .clearByIdPrefix("knowledge", `${namespace}-`);
    scheduleClientModuleSync();
  };

  const runCommand = async (
    item: SourceState,
    kind: "test" | "sync" | "rebuild",
  ) => {
    const { pluginId } = item;
    const sourceId = item.decl.sourceId;
    patchSource(pluginId, sourceId, {
      busy: kind,
      message: "",
      testResult: null,
    });
    try {
      if (kind === "test") {
        const result = await unwrapCommand(commands.ksTest(pluginId, sourceId));
        patchSource(pluginId, sourceId, {
          testResult: result,
          message: result.ok
            ? fillText(t("knowledge.ks.testOk"), {
                notebooks: result.notebooks,
                docs: result.docs,
              })
            : result.message,
        });
        return;
      }
      const report =
        kind === "rebuild"
          ? await unwrapCommand(commands.ksSyncRebuild(pluginId, sourceId))
          : await unwrapCommand(commands.ksSyncNow(pluginId, sourceId));
      finishReport(pluginId, sourceId, item.decl.sourceId, report);
      await loadEntries();
    } catch (err) {
      patchSource(pluginId, sourceId, {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      patchSource(pluginId, sourceId, { busy: null });
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="knowledge-switcher-backdrop" onClick={onClose}>
      <div
        className="knowledge-switcher knowledge-siyuan-dialog"
        role="dialog"
        aria-label={t("knowledge.ks.title")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <WorkbenchPanelHeader
          label={t("knowledge.ks.title")}
          actions={
            <WorkbenchActionButton onClick={onClose}>
              {t("knowledge.ks.close")}
            </WorkbenchActionButton>
          }
        />
        <div className="knowledge-siyuan-dialog__body">
          {loading && <p className="knowledge-siyuan-dialog__hint">{t("knowledge.ks.loading")}</p>}
          {error && <p className="knowledge-siyuan-dialog__message">{error}</p>}
          {!loading && sources.length === 0 && !error && (
            <p className="knowledge-siyuan-dialog__hint">{t("knowledge.ks.empty")}</p>
          )}
          {sources.map((item) => {
            const key = `${item.pluginId}:${item.decl.sourceId}`;
            const status = item.status;
            return (
              <section key={key} className="knowledge-siyuan-dialog__source">
                <header className="knowledge-siyuan-dialog__source-head">
                  <strong>{item.decl.title || item.decl.sourceId}</strong>
                  <span className="knowledge-siyuan-dialog__hint">{item.pluginId}</span>
                </header>
                {item.decl.fields.map((field) =>
                  renderFieldInput(
                    field.key,
                    field,
                    field.kind === "secret"
                      ? (item.secrets[field.key] ?? "")
                      : (item.values[field.key] ?? ""),
                    field.kind === "secret" && Boolean(item.secretsSaved[field.key]),
                    item.busy !== null,
                    t("knowledge.ks.secretSaved"),
                    (value) =>
                      setFieldValue(
                        item.pluginId,
                        item.decl.sourceId,
                        field.key,
                        value,
                        field.kind === "secret",
                      ),
                  ),
                )}
                <div className="knowledge-siyuan-dialog__row">
                  <WorkbenchActionButton
                    onClick={() => void handleSave(item)}
                    disabled={item.busy !== null}
                  >
                    {t("knowledge.ks.save")}
                  </WorkbenchActionButton>
                  <WorkbenchActionButton
                    onClick={() => void runCommand(item, "test")}
                    disabled={item.busy !== null}
                  >
                    {item.busy === "test"
                      ? t("knowledge.ks.testing")
                      : t("knowledge.ks.test")}
                  </WorkbenchActionButton>
                  <WorkbenchActionButton
                    onClick={() => void runCommand(item, "sync")}
                    disabled={item.busy !== null}
                  >
                    {item.busy === "sync"
                      ? t("knowledge.ks.syncing")
                      : t("knowledge.ks.syncNow")}
                  </WorkbenchActionButton>
                  <WorkbenchActionButton
                    onClick={() => void runCommand(item, "rebuild")}
                    disabled={item.busy !== null}
                    title={t("knowledge.ks.rebuildHint")}
                  >
                    {item.busy === "rebuild"
                      ? t("knowledge.ks.syncing")
                      : t("knowledge.ks.rebuild")}
                  </WorkbenchActionButton>
                </div>
                {item.message && (
                  <p className="knowledge-siyuan-dialog__message">{item.message}</p>
                )}
                <div className="knowledge-siyuan-dialog__status">
                  <span>
                    {status && status.lastSyncAt
                      ? fillText(t("knowledge.ks.lastSync"), {
                          time: formatTime(status.lastSyncAt),
                        })
                      : t("knowledge.ks.neverSynced")}
                  </span>
                  {status?.report && status.report.failed.length > 0 && (
                    <div className="knowledge-siyuan-dialog__failed">
                      <span>{t("knowledge.ks.failedList")}</span>
                      <ul>
                        {status.report.failed.slice(0, 20).map((failure) => (
                          <li key={failure.fileKey}>
                            {failure.fileKey}：{failure.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 原生思源配置自动播种：ks 无配置且原生有工作空间路径时沿用 rootPath。 */
async function autoSeedFromNative(
  sources: Array<{
    pluginId: string;
    decl: { sourceId: string };
    values: Record<string, string>;
  }>,
): Promise<void> {
  try {
    const target = sources.find(
      (item) =>
        item.pluginId === "omni.knowledge.siyuan" &&
        item.decl.sourceId === "siyuan" &&
        Object.keys(item.values).length === 0,
    );
    if (!target) return;
    const native = await unwrapCommand(commands.siyuanConfigGet(), { quiet: true });
    const workspacePath = (native?.workspacePath ?? "").trim();
    if (!workspacePath) return;
    await unwrapCommand(
      commands.ksConfigSave(
        target.pluginId,
        target.decl.sourceId,
        target.pluginId,
        JSON.stringify({ rootPath: workspacePath }),
      ),
    );
    target.values = { rootPath: workspacePath };
  } catch {
    // 播种失败不挡主流程
  }
}

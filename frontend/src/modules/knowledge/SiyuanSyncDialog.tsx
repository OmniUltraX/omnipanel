import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n";
import {
  commands,
  type SiyuanSyncConfig,
  type SiyuanSyncReport,
  type SiyuanSyncStatus,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import {
  scheduleClientModuleSync,
  useClientSyncTombstoneStore,
} from "../clientSync";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";

function formatTime(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

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

const EMPTY_REPORT: SiyuanSyncReport = {
  scanned: 0,
  added: 0,
  updated: 0,
  archived: 0,
  failed: [],
  startedAtMs: 0,
  finishedAtMs: 0,
};

export function SiyuanSyncDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const loadEntries = useKnowledgeStore((s) => s.loadEntries);
  const [config, setConfig] = useState<SiyuanSyncConfig | null>(null);
  const [status, setStatus] = useState<SiyuanSyncStatus | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "sync" | "rebuild" | null>(null);
  const [message, setMessage] = useState("");
  const [testOk, setTestOk] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([
        unwrapCommand(commands.siyuanConfigGet()),
        unwrapCommand(commands.siyuanSyncStatus()),
      ]);
      setConfig(cfg);
      setStatus(st);
      setMessage("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setTestOk(false);
      void reload();
    }
  }, [open, reload]);

  const patch = useCallback((part: Partial<SiyuanSyncConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...part } : prev));
    setTestOk(false);
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await openFileDialog({ directory: true });
      if (typeof selected === "string" && selected.length > 0) {
        patch({ workspacePath: selected });
      }
    } catch {
      // 用户取消选择时不提示
    }
  }, [patch]);

  const handleSave = useCallback(async () => {
    if (!config || busy) return;
    setBusy("save");
    try {
      await unwrapCommand(commands.siyuanConfigSave(config));
      setMessage(t("knowledge.siyuan.saved"));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, config, t]);

  const handleTest = useCallback(async () => {
    if (!config || busy) return;
    setBusy("test");
    try {
      const result = await unwrapCommand(commands.siyuanTestConnection(config));
      if (result.ok) {
        setTestOk(true);
        setMessage(
          fillText(t("knowledge.siyuan.testOk"), {
            notebooks: result.notebooks,
            docs: result.docs,
          }),
        );
      } else {
        setTestOk(false);
        setMessage(result.message);
      }
    } catch (err) {
      setTestOk(false);
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, config, t]);

  const finishSyncReport = (report: SiyuanSyncReport) => {
    setStatus((prev) =>
      prev
        ? {
            lastSyncAt: report.finishedAtMs,
            report,
          }
        : { lastSyncAt: report.finishedAtMs, report },
    );
    setMessage(
      fillText(t("knowledge.siyuan.syncDone"), {
        added: report.added,
        updated: report.updated,
        archived: report.archived,
        failed: report.failed.length,
      }),
    );
    // 陈旧墓碑会继续杀复活：清掉 siyuan 前缀的墓碑；
    // 再把含新文档的快照推云端，否则下次启动拉取会对齐删除。
    useClientSyncTombstoneStore.getState().clearByIdPrefix("knowledge", "siyuan-");
    scheduleClientModuleSync();
  };

  const handleSync = useCallback(async () => {
    if (busy) return;
    setBusy("sync");
    try {
      const report = await unwrapCommand(commands.siyuanSyncNow());
      finishSyncReport(report);
      await loadEntries();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, loadEntries, t]);

  const handleRebuild = useCallback(async () => {
    if (busy) return;
    setBusy("rebuild");
    try {
      const report = await unwrapCommand(commands.siyuanSyncRebuild());
      finishSyncReport(report);
      await loadEntries();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, loadEntries, t]);

  if (!open) return null;

  const report: SiyuanSyncReport = status?.report ?? EMPTY_REPORT;
  const isS3 = config?.sourceType === "s3";

  return createPortal(
    <div className="knowledge-switcher-backdrop" onClick={onClose}>
      <div
        className="knowledge-switcher knowledge-siyuan-dialog"
        role="dialog"
        aria-label={t("knowledge.siyuan.title")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <WorkbenchPanelHeader
          label={t("knowledge.siyuan.title")}
          actions={
            <WorkbenchActionButton onClick={onClose}>
              {t("knowledge.siyuan.close")}
            </WorkbenchActionButton>
          }
        />
        <div className="knowledge-siyuan-dialog__body">
          <div className="knowledge-siyuan-dialog__row">
            <label>
              <input
                type="radio"
                name="siyuan-source"
                checked={!isS3}
                onChange={() => patch({ sourceType: "local" })}
              />
              {t("knowledge.siyuan.sourceLocal")}
            </label>
            <label className="knowledge-siyuan-dialog__disabled">
              <input type="radio" name="siyuan-source" checked={isS3} disabled />
              {t("knowledge.siyuan.sourceS3")}
            </label>
          </div>
          <p className="knowledge-siyuan-dialog__hint">
            {t("knowledge.siyuan.sourceS3Pending")}
          </p>

          {!isS3 && (
            <div className="knowledge-siyuan-dialog__field">
              <span>{t("knowledge.siyuan.workspacePath")}</span>
              <div className="knowledge-siyuan-dialog__row">
                <input
                  className="knowledge-siyuan-dialog__input"
                  value={config?.workspacePath ?? ""}
                  placeholder={t("knowledge.siyuan.workspacePlaceholder")}
                  onChange={(event) => patch({ workspacePath: event.target.value })}
                />
                <WorkbenchActionButton onClick={() => void handleBrowse()}>
                  {t("knowledge.siyuan.browse")}
                </WorkbenchActionButton>
              </div>
            </div>
          )}

          {isS3 && (
            <div className="knowledge-siyuan-dialog__field">
              <span>{t("knowledge.siyuan.s3Endpoint")}</span>
              <input
                className="knowledge-siyuan-dialog__input"
                value={config?.s3Endpoint ?? ""}
                disabled
                onChange={(event) => patch({ s3Endpoint: event.target.value })}
              />
              <span>{t("knowledge.siyuan.s3Bucket")}</span>
              <input
                className="knowledge-siyuan-dialog__input"
                value={config?.s3Bucket ?? ""}
                disabled
                onChange={(event) => patch({ s3Bucket: event.target.value })}
              />
              <span>{t("knowledge.siyuan.s3Region")}</span>
              <input
                className="knowledge-siyuan-dialog__input"
                value={config?.s3Region ?? ""}
                disabled
                onChange={(event) => patch({ s3Region: event.target.value })}
              />
              <span>{t("knowledge.siyuan.s3AccessKey")}</span>
              <input
                className="knowledge-siyuan-dialog__input"
                value={config?.s3AccessKey ?? ""}
                disabled
                onChange={(event) => patch({ s3AccessKey: event.target.value })}
              />
            </div>
          )}

          <div className="knowledge-siyuan-dialog__row">
            <WorkbenchActionButton
              onClick={() => void handleSave()}
              disabled={busy !== null}
            >
              {t("knowledge.siyuan.save")}
            </WorkbenchActionButton>
            <WorkbenchActionButton
              onClick={() => void handleTest()}
              disabled={busy !== null}
            >
              {busy === "test"
                ? t("knowledge.siyuan.testing")
                : t("knowledge.siyuan.test")}
            </WorkbenchActionButton>
            <WorkbenchActionButton
              onClick={() => void handleSync()}
              disabled={busy !== null || (isS3 && !testOk)}
            >
              {busy === "sync"
                ? t("knowledge.siyuan.syncing")
                : t("knowledge.siyuan.syncNow")}
            </WorkbenchActionButton>
            <WorkbenchActionButton
              onClick={() => void handleRebuild()}
              disabled={busy !== null || isS3}
              title={t("knowledge.siyuan.rebuildHint")}
            >
              {busy === "rebuild"
                ? t("knowledge.siyuan.syncing")
                : t("knowledge.siyuan.rebuild")}
            </WorkbenchActionButton>
          </div>

          {message && <p className="knowledge-siyuan-dialog__message">{message}</p>}

          <div className="knowledge-siyuan-dialog__status">
            <span>
              {status && status.lastSyncAt
                ? fillText(t("knowledge.siyuan.lastSync"), {
                    time: formatTime(status.lastSyncAt),
                  })
                : t("knowledge.siyuan.neverSynced")}
            </span>
            {report.failed.length > 0 && (
              <div className="knowledge-siyuan-dialog__failed">
                <span>{t("knowledge.siyuan.failedList")}</span>
                <ul>
                  {report.failed.slice(0, 20).map((item) => (
                    <li key={item.fileKey}>
                      {item.fileKey}：{item.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

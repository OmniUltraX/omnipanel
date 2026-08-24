import { useCallback, useEffect, useState } from "react";
import type { ImportCandidate } from "@omnipanel/plugin-sdk";
import { FormDialog } from "@omnipanel/plugin-ui";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { TextInput } from "@omnipanel/plugin-ui";
import { ImportPreview } from "@omnipanel/plugin-ui";
import { useI18n } from "../../i18n";
import { createPluginHost } from "../../lib/pluginHost";
import { upsertImportCandidates } from "../../lib/importCandidates";
import { getImporterContribution } from "../../lib/importerContributionRegistry";
import { isPluginActivated, PLUGIN_ID_WARPGATE } from "../../stores/pluginRuntimeStore";
import { getPluginManifest } from "../../lib/pluginManifests";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";

let openHandler: (() => void) | null = null;

export function openWarpgateImport(): void {
  openHandler?.();
}

export function registerWarpgateImportOpener(fn: (() => void) | null): void {
  openHandler = fn;
}

export function WarpgateImportDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null,
  );

  useEffect(() => {
    registerWarpgateImportOpener(() => setOpen(true));
    return () => registerWarpgateImportOpener(null);
  }, []);

  const loadCandidates = useCallback(async () => {
    const contribution = getImporterContribution("warpgate");
    if (!contribution) {
      setStatus({
        kind: "error",
        message: t("plugins.warpgate.contributionMissing"),
      });
      return;
    }
    const manifest = getPluginManifest(PLUGIN_ID_WARPGATE);
    const logicReady =
      manifest?.entry?.logic != null && isPluginActivated(PLUGIN_ID_WARPGATE);
    if (logicReady) {
      // L2 逻辑包可用：走 Warpgate HTTP API 真实拉取（prod 闸由后端桥强制）
      if (!/^https?:\/\//.test(baseUrl.trim())) {
        setStatus({ kind: "error", message: t("plugins.warpgate.baseUrlRequired") });
        return;
      }
      try {
        setBusy(true);
        const result = await unwrapCommand(
          commands.pluginInvoke(PLUGIN_ID_WARPGATE, "fetchTargets", {
            baseUrl: baseUrl.trim(),
            token,
          } as never),
        );
        const targetsRaw =
          (result as { targets?: ImportCandidate[] }).targets ?? [];
        const mapped = upsertImportCandidates([], targetsRaw);
        setCandidates(mapped);
        setSelectedIds(new Set(mapped.map((item) => item.remoteId)));
        setStatus({ kind: "success", message: t("plugins.warpgate.loadedRemote") });
      } catch (err) {
        setStatus({ kind: "error", message: String(err) });
      } finally {
        setBusy(false);
      }
      return;
    }
    const mapped = contribution.getPreviewCandidates(token);
    setCandidates(upsertImportCandidates([], mapped));
    setSelectedIds(new Set(mapped.map((item) => item.remoteId)));
    setStatus({
      kind: "info",
      message: t("plugins.warpgate.loadedMock"),
    });
  }, [t, token]);

  const handleImport = useCallback(async () => {
    const chosen = candidates.filter((item) => selectedIds.has(item.remoteId));
    if (chosen.length === 0) return;
    const contribution = getImporterContribution("warpgate");
    if (!contribution) {
      setStatus({ kind: "error", message: t("plugins.warpgate.contributionMissing") });
      return;
    }
    setBusy(true);
    try {
      const host = createPluginHost(contribution.pluginId);
      for (const item of chosen) {
        await host.connections.upsert(item);
      }
      setStatus({ kind: "success", message: t("plugins.warpgate.imported") });
      setOpen(false);
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    } finally {
      setBusy(false);
    }
  }, [candidates, selectedIds, t]);

  return (
    <FormDialog
      open={open}
      onClose={() => setOpen(false)}
      title={t("plugins.warpgate.title")}
      status={status}
      primaryAction={{
        label: t("plugins.warpgate.import"),
        disabled: busy || selectedIds.size === 0,
        onClick: () => void handleImport(),
      }}
    >
      <p className="setting-hint">{t("plugins.warpgate.hint")}</p>
      <TextInput
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder={t("plugins.warpgate.baseUrlPlaceholder")}
      />
      <PasswordInput
        value={token}
        onChange={setToken}
        placeholder={t("plugins.warpgate.tokenPlaceholder")}
      />
      <p className="setting-hint">{t("plugins.warpgate.tokenNote")}</p>
      <button type="button" className="btn btn-secondary" onClick={loadCandidates} disabled={busy}>
        {t("plugins.warpgate.load")}
      </button>
      <ImportPreview
        items={candidates.map((item) => ({
          id: item.remoteId,
          name: item.name,
          host: String((item.config as { host?: string } | undefined)?.host ?? ""),
          kind: item.remoteKind,
        }))}
        selectedIds={selectedIds}
        onToggle={(id, next) => {
          setSelectedIds((prev) => {
            const copy = new Set(prev);
            if (next) copy.add(id);
            else copy.delete(id);
            return copy;
          });
        }}
        columns={[
          { id: "name", header: t("plugins.warpgate.colName"), render: (row) => row.name },
          { id: "kind", header: t("plugins.warpgate.colKind"), render: (row) => row.kind },
          { id: "host", header: t("plugins.warpgate.colHost"), render: (row) => row.host },
        ]}
      />
    </FormDialog>
  );
}

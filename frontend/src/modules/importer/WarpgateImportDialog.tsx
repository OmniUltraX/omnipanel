import { useCallback, useEffect, useState } from "react";
import type { ImportCandidate } from "@omnipanel/plugin-sdk";
import { FormDialog } from "@omnipanel/plugin-ui";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { ImportPreview } from "@omnipanel/plugin-ui";
import { useI18n } from "../../i18n";
import { createPluginHost } from "../../lib/pluginHost";
import { upsertImportCandidates } from "../../lib/importCandidates";
import {
  MOCK_WARPGATE_TARGETS,
  targetsToCandidates,
  WARPGATE_PLUGIN_ID,
} from "../../../../plugins/importer-warpgate/src/index";

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

  const loadCandidates = useCallback(() => {
    const mapped = targetsToCandidates("warpgate-mock", MOCK_WARPGATE_TARGETS);
    setCandidates(upsertImportCandidates([], mapped));
    setSelectedIds(new Set(mapped.map((item) => item.remoteId)));
    setStatus({
      kind: "info",
      message: t("plugins.warpgate.loadedMock"),
    });
  }, [t]);

  const handleImport = useCallback(async () => {
    const chosen = candidates.filter((item) => selectedIds.has(item.remoteId));
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      const host = createPluginHost(WARPGATE_PLUGIN_ID);
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

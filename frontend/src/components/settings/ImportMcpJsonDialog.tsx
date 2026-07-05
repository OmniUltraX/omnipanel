import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import type { McpServiceView, UpsertMcpServiceInput } from "../../stores/mcpServicesStore";
import {
  isBuiltinOmniMcpUrl,
  parseMcpConfigJson,
  parsedServerSummary,
  toUpsertMcpServiceInput,
  type ParsedMcpServerConfig,
} from "../../lib/mcp/parseMcpConfigJson";
import { FormDialog } from "../ui/form/FormDialog";
import { Button } from "../ui/primitives/Button";

interface ImportMcpJsonDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: UpsertMcpServiceInput) => Promise<McpServiceView | null>;
  onImported?: () => void;
}

export function ImportMcpJsonDialog({
  open,
  onClose,
  onSubmit,
  onImported,
}: ImportMcpJsonDialogProps) {
  const { t } = useI18n();
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [parsed, setParsed] = useState<ParsedMcpServerConfig[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setJsonText("");
    setError(null);
    setParsed(null);
    setImporting(false);
  }, [open]);

  const { importable, skippedBuiltin } = useMemo(() => {
    if (!parsed) return { importable: [] as ParsedMcpServerConfig[], skippedBuiltin: 0 };
    const importableList: ParsedMcpServerConfig[] = [];
    let skipped = 0;
    for (const server of parsed) {
      if (server.transportKind === "sse" && isBuiltinOmniMcpUrl(server.url)) {
        skipped += 1;
        continue;
      }
      importableList.push(server);
    }
    return { importable: importableList, skippedBuiltin: skipped };
  }, [parsed]);

  const handleParse = () => {
    setError(null);
    try {
      setParsed(parseMcpConfigJson(jsonText));
    } catch (e) {
      setParsed(null);
      setError(e instanceof Error ? e.message : t("settings.mcpServices.import.parseFailed"));
    }
  };

  const handlePasteClipboard = async () => {
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setError(t("settings.mcpServices.import.clipboardEmpty"));
        return;
      }
      setJsonText(text);
      setParsed(parseMcpConfigJson(text));
    } catch (e) {
      setParsed(null);
      setError(
        e instanceof Error ? e.message : t("settings.mcpServices.import.clipboardFailed"),
      );
    }
  };

  const handleImport = async () => {
    let targets = importable;
    if (!parsed) {
      try {
        const all = parseMcpConfigJson(jsonText);
        targets = all.filter(
          (server) => !(server.transportKind === "sse" && isBuiltinOmniMcpUrl(server.url)),
        );
        setParsed(all);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("settings.mcpServices.import.parseFailed"));
        return;
      }
    }

    if (targets.length === 0) {
      setError(t("settings.mcpServices.import.nothingToImport"));
      return;
    }

    setImporting(true);
    setError(null);
    let failed = 0;
    try {
      for (const server of targets) {
        const saved = await onSubmit(toUpsertMcpServiceInput(server));
        if (!saved) failed += 1;
      }
      if (failed > 0) {
        setError(t("settings.mcpServices.import.partialFailed", { count: failed }));
        return;
      }
      onImported?.();
      onClose();
    } finally {
      setImporting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("settings.mcpServices.import.title")}
      subtitle={t("settings.mcpServices.import.subtitle")}
      titleId="import-mcp-json-title"
      size="md"
      bodyClassName="import-mcp-json-body"
      clipboardAssist={false}
      cancelLabel={t("settings.mcpServices.add.cancel")}
      cancelVariant="ghost"
      primaryAction={{
        label: importing
          ? t("settings.mcpServices.import.importing")
          : parsed && importable.length > 0
            ? t("settings.mcpServices.import.confirm", { count: importable.length })
            : t("settings.mcpServices.import.confirmShort"),
        onClick: () => void handleImport(),
        disabled: importing || (!jsonText.trim() && importable.length === 0),
      }}
    >
      <div className="import-mcp-json-actions">
        <Button variant="secondary" size="sm" onClick={() => void handlePasteClipboard()}>
          {t("settings.mcpServices.import.pasteClipboard")}
        </Button>
        <Button variant="secondary" size="sm" onClick={handleParse}>
          {t("settings.mcpServices.import.parse")}
        </Button>
      </div>

      <textarea
        className="settings-textarea import-mcp-json-textarea"
        rows={10}
        value={jsonText}
        onChange={(e) => {
          setJsonText(e.target.value);
          setParsed(null);
          setError(null);
        }}
        placeholder={t("settings.mcpServices.import.placeholder")}
        spellCheck={false}
      />

      {parsed ? (
        <div className="import-mcp-json-preview">
          <div className="settings-subsection-title">
            {t("settings.mcpServices.import.previewTitle", { count: parsed.length })}
          </div>
          <ul className="import-mcp-json-preview-list">
            {parsed.map((server) => (
              <li key={server.key} className="import-mcp-json-preview-item">
                <div className="import-mcp-json-preview-name">{server.name}</div>
                <div className="import-mcp-json-preview-meta">
                  <span className="import-mcp-json-preview-tag">
                    {server.transportKind === "sse"
                      ? t("settings.mcpServices.transportSse")
                      : t("settings.mcpServices.transportStdio")}
                  </span>
                  <code>{parsedServerSummary(server)}</code>
                </div>
                {server.transportKind === "sse" && isBuiltinOmniMcpUrl(server.url) ? (
                  <div className="setting-hint">{t("settings.mcpServices.import.skipBuiltin")}</div>
                ) : null}
              </li>
            ))}
          </ul>
          {skippedBuiltin > 0 ? (
            <p className="setting-hint">{t("settings.mcpServices.import.skippedBuiltin", { count: skippedBuiltin })}</p>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="form-error">{error}</div> : null}
    </FormDialog>
  );
}

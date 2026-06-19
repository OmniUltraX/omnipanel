import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FormDialog, FormField } from "../ui/FormDialog";
import { useI18n } from "../../i18n";
import type { McpServiceView, UpsertMcpServiceInput } from "../../stores/mcpServicesStore";
import type { McpTransportKind } from "../../ipc/bindings";

interface AddMcpServiceDialogProps {
  open: boolean;
  onClose: () => void;
  editService?: McpServiceView | null;
  onSaved?: (serviceId: string) => void;
  onSubmit: (input: UpsertMcpServiceInput) => Promise<McpServiceView | null>;
}

interface FormState {
  name: string;
  enabled: boolean;
  transportKind: McpTransportKind;
  command: string;
  argsText: string;
  url: string;
  cwd: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  enabled: true,
  transportKind: "stdio",
  command: "",
  argsText: "",
  url: "",
  cwd: "",
};

function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function AddMcpServiceDialog({
  open,
  onClose,
  editService,
  onSaved,
  onSubmit,
}: AddMcpServiceDialogProps) {
  const { t } = useI18n();
  const isEdit = Boolean(editService);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editService) {
      const transportKind = editService.transport.kind;
      setForm({
        name: editService.name,
        enabled: editService.enabled,
        transportKind,
        command:
          editService.transport.kind === "stdio"
            ? editService.transport.config.command
            : "",
        argsText:
          editService.transport.kind === "stdio"
            ? (editService.transport.config.args ?? []).join("\n")
            : "",
        url:
          editService.transport.kind === "sse"
            ? editService.transport.config.url
            : "",
        cwd:
          editService.transport.kind === "stdio"
            ? editService.transport.config.cwd ?? ""
            : "",
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
    setError(null);
    setPicking(false);
    setSubmitting(false);
  }, [open, editService]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const handlePickCommand = async () => {
    setPicking(true);
    setError(null);
    try {
      const selected = await openFileDialog({
        title: t("settings.mcpServices.pickCommand"),
        multiple: false,
        directory: false,
      });
      if (typeof selected === "string" && selected.length > 0) {
        setForm((prev) => ({ ...prev, command: selected }));
      }
    } catch (e) {
      console.warn("[AddMcpServiceDialog] 文件选择失败:", e);
      setError(
        e instanceof Error ? e.message : t("settings.mcpServices.errors.pickFailed"),
      );
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    const name = form.name.trim();
    if (!name) {
      setError(t("settings.mcpServices.errors.nameRequired"));
      return;
    }

    const input: UpsertMcpServiceInput = {
      id: editService?.id ?? null,
      name,
      enabled: form.enabled,
      transportKind: form.transportKind,
      command: form.transportKind === "stdio" ? form.command.trim() : null,
      args: form.transportKind === "stdio" ? parseArgs(form.argsText) : [],
      env: [],
      cwd: form.transportKind === "stdio" && form.cwd.trim() ? form.cwd.trim() : null,
      url: form.transportKind === "sse" ? form.url.trim() : null,
    };

    if (form.transportKind === "stdio" && !input.command) {
      setError(t("settings.mcpServices.errors.commandRequired"));
      return;
    }
    if (form.transportKind === "sse" && !input.url) {
      setError(t("settings.mcpServices.errors.urlRequired"));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const saved = await onSubmit(input);
      if (saved) {
        onSaved?.(saved.id);
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={
        isEdit ? t("settings.mcpServices.edit.title") : t("settings.mcpServices.add.title")
      }
      subtitle={
        isEdit
          ? t("settings.mcpServices.edit.subtitle")
          : t("settings.mcpServices.add.subtitle")
      }
      titleId="add-mcp-service-title"
      size="sm"
      bodyClassName="add-mcp-service-body"
      cancelLabel={t("settings.mcpServices.add.cancel")}
      cancelVariant="ghost"
      primaryAction={{
        label: isEdit
          ? t("settings.mcpServices.edit.confirm")
          : t("settings.mcpServices.add.confirm"),
        onClick: () => void submit(),
        disabled: submitting,
      }}
    >
      <FormField label={t("settings.mcpServices.fields.name")} htmlFor="add-mcp-name">
        <input
          id="add-mcp-name"
          className="input"
          autoFocus
          value={form.name}
          onChange={(e) => updateField("name", e.target.value)}
          placeholder={t("settings.mcpServices.fields.namePlaceholder")}
        />
      </FormField>

      <FormField label={t("settings.mcpServices.fields.transport")}>
        <div className="form-radio-group">
          <label className="form-radio-option">
            <input
              type="radio"
              name="mcp-transport"
              checked={form.transportKind === "stdio"}
              onChange={() => updateField("transportKind", "stdio")}
            />
            <span>{t("settings.mcpServices.fields.transportStdio")}</span>
          </label>
          <label className="form-radio-option">
            <input
              type="radio"
              name="mcp-transport"
              checked={form.transportKind === "sse"}
              onChange={() => updateField("transportKind", "sse")}
            />
            <span>{t("settings.mcpServices.fields.transportSse")}</span>
          </label>
        </div>
      </FormField>

      {form.transportKind === "stdio" ? (
        <>
          <FormField label={t("settings.mcpServices.fields.command")} htmlFor="add-mcp-command">
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <input
                id="add-mcp-command"
                className="input"
                value={form.command}
                onChange={(e) => updateField("command", e.target.value)}
                placeholder={t("settings.mcpServices.fields.commandPlaceholder")}
                style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handlePickCommand()}
                disabled={picking}
              >
                {t("settings.mcpServices.browse")}
              </button>
            </div>
          </FormField>

          <FormField
            label={t("settings.mcpServices.fields.args")}
            htmlFor="add-mcp-args"
            description={t("settings.mcpServices.fields.argsHint")}
          >
            <textarea
              id="add-mcp-args"
              className="input"
              rows={3}
              value={form.argsText}
              onChange={(e) => updateField("argsText", e.target.value)}
              placeholder={t("settings.mcpServices.fields.argsPlaceholder")}
              style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
            />
          </FormField>

          <FormField label={t("settings.mcpServices.fields.cwd")} htmlFor="add-mcp-cwd">
            <input
              id="add-mcp-cwd"
              className="input"
              value={form.cwd}
              onChange={(e) => updateField("cwd", e.target.value)}
              placeholder={t("settings.mcpServices.fields.cwdPlaceholder")}
              style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
            />
          </FormField>
        </>
      ) : (
        <FormField
          label={t("settings.mcpServices.fields.url")}
          htmlFor="add-mcp-url"
          description={t("settings.mcpServices.fields.urlHint")}
        >
          <input
            id="add-mcp-url"
            className="input"
            value={form.url}
            onChange={(e) => updateField("url", e.target.value)}
            placeholder={t("settings.mcpServices.fields.urlPlaceholder")}
            style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
          />
        </FormField>
      )}

      <FormField label={t("settings.mcpServices.fields.enabled")}>
        <label
          className="form-radio-option"
          style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => updateField("enabled", e.target.checked)}
          />
          <span>{t("settings.mcpServices.fields.enabled")}</span>
        </label>
      </FormField>

      {error && <div className="form-error">{error}</div>}
    </FormDialog>
  );
}

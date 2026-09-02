import { useEffect, useMemo, useState } from "react";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import { commands, type Connection } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { parseServiceConfig } from "../../lib/moduleCapabilities";
import { useConnectionStore } from "../../stores/connectionStore";
import { GlobalTagEditor } from "../tags/GlobalTagEditor";
import { mergeConnectionTags, userConnectionTags } from "../tags/tagKinds";
import { invokeModuleMethod } from "./moduleInvoke";

type FormFieldDecl = { key: string; type: string; optional: boolean };

const FIELD_I18N: Record<string, "host" | "port" | "contextPath" | "useHttps" | "username" | "password" | "namespaceId" | "dialect"> = {
  host: "host",
  port: "port",
  contextPath: "contextPath",
  useHttps: "useHttps",
  username: "username",
  password: "password",
  namespaceId: "namespaceId",
  dialect: "dialect",
};

function fieldsFromManifest(raw: unknown): FormFieldDecl[] {
  if (!raw || typeof raw !== "object") return [];
  const fields = (raw as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const key = String((item as { key?: unknown }).key ?? "").trim();
      if (!key) return null;
      return {
        key,
        type: String((item as { type?: unknown }).type ?? "text"),
        optional: Boolean((item as { optional?: unknown }).optional),
      };
    })
    .filter((item): item is FormFieldDecl => Boolean(item));
}

function emptyValues(fields: FormFieldDecl[], defaultPort?: number): Record<string, string> {
  const out: Record<string, string> = { name: "", envTag: "dev" };
  for (const field of fields) {
    if (field.key === "port") out[field.key] = defaultPort && defaultPort > 0 ? String(defaultPort) : "";
    else if (field.key === "useHttps") out[field.key] = "false";
    else out[field.key] = "";
  }
  return out;
}

export function ServiceConnectionDialog({
  open,
  pluginId,
  connectionForm,
  defaultPort,
  editConnection,
  onClose,
}: {
  open: boolean;
  pluginId: string;
  connectionForm: unknown;
  defaultPort?: number;
  editConnection?: Connection;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const save = useConnectionStore((s) => s.save);
  const fields = useMemo(() => fieldsFromManifest(connectionForm), [connectionForm]);
  const [values, setValues] = useState<Record<string, string>>(() => emptyValues(fields, defaultPort));
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    const next = emptyValues(fields, defaultPort);
    if (editConnection) {
      const cfg = parseServiceConfig(editConnection.config);
      next.name = editConnection.name;
      next.envTag = editConnection.envTag ?? "dev";
      for (const field of fields) {
        if (field.type === "password") continue;
        const raw = cfg[field.key];
        if (raw === true || raw === false) next[field.key] = raw ? "true" : "false";
        else if (raw != null) next[field.key] = String(raw);
      }
    }
    setValues(next);
    setTags(userConnectionTags(editConnection?.tags));
    setStatus(null);
  }, [open, editConnection, fields, defaultPort]);

  const fieldLabel = (key: string) => {
    const mapped = FIELD_I18N[key];
    return mapped ? t(`moduleHost.field.${mapped}`) : key;
  };

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  };

  const buildConnection = (): Connection => {
    const config: Record<string, unknown> = { pluginId };
    for (const field of fields) {
      if (field.type === "password") continue;
      const raw = values[field.key] ?? "";
      if (field.type === "number") config[field.key] = Number(raw) || 0;
      else if (field.type === "checkbox") config[field.key] = raw === "true";
      else if (raw.trim()) config[field.key] = raw.trim();
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      id: editConnection?.id ?? "",
      kind: "service",
      name: (values.name || String(config.host || pluginId)).trim(),
      group: editConnection?.group ?? "",
      envTag: values.envTag || "dev",
      tags: mergeConnectionTags(tags, editConnection?.tags),
      config: JSON.stringify(config),
      createdAt: editConnection?.createdAt ?? now,
      updatedAt: now,
    };
  };

  const handleTest = async () => {
    setTesting(true);
    setStatus({ kind: "info", message: t("moduleHost.testing") });
    try {
      const draft = buildConnection();
      const result = await invokeModuleMethod<{ dialect?: string; auth?: string }>(
        pluginId,
        "testConnection",
        {
          ...parseServiceConfig(draft.config),
          password: values.password || undefined,
          passwordKey: editConnection?.id,
          connectionId: editConnection?.id,
        },
      );
      setStatus({
        kind: "success",
        message: t("moduleHost.testOk", {
          dialect: result.dialect ?? "auto",
          auth: result.auth ?? "none",
        }),
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : formatIpcError(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      const draft = buildConnection();
      const saved = await save(draft);
      if (!saved) throw new Error(t("moduleHost.saveFailed"));
      const password = values.password?.trim();
      if (password) {
        await unwrapCommand(commands.pluginSecretPut(pluginId, saved.id, password));
      }
      onClose();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : formatIpcError(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      title={editConnection ? t("moduleHost.editConnection") : t("moduleHost.newConnection")}
      onClose={onClose}
      status={status}
      actions={[
        {
          key: "test",
          label: t("moduleHost.test"),
          disabled: testing || busy,
          onClick: () => void handleTest(),
        },
      ]}
      primaryAction={{
        key: "save",
        label: t("common.save"),
        disabled: busy,
        onClick: () => void handleSave(),
      }}
    >
      <FormField label={t("moduleHost.field.name")}>
        <TextInput value={values.name ?? ""} onChange={(value) => setField("name", value)} />
      </FormField>
      {fields.map((field) => {
        if (field.type === "password") {
          return (
            <FormField key={field.key} label={fieldLabel(field.key)}>
              <PasswordInput
                value={values[field.key] ?? ""}
                onChange={(value) => setField(field.key, value)}
              />
            </FormField>
          );
        }
        if (field.type === "checkbox") {
          return (
            <label key={field.key} className="module-host-check">
              <input
                type="checkbox"
                checked={values[field.key] === "true"}
                onChange={(event) => setField(field.key, event.target.checked ? "true" : "false")}
              />
              {fieldLabel(field.key)}
            </label>
          );
        }
        return (
          <FormField key={field.key} label={fieldLabel(field.key)}>
            <TextInput
              value={values[field.key] ?? ""}
              onChange={(value) => setField(field.key, value)}
            />
          </FormField>
        );
      })}
      <FormField label={t("moduleHost.field.envTag")}>
        <TextInput value={values.envTag ?? "dev"} onChange={(value) => setField("envTag", value)} />
      </FormField>
      <GlobalTagEditor
        kind="connection"
        resourceId={editConnection?.id || pluginId}
        tags={tags}
        onChange={setTags}
      />
    </FormDialog>
  );
}

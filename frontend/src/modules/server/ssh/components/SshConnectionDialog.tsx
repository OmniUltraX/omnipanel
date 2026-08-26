import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { GlobalTagEditor } from "../../../tags/GlobalTagEditor";
import { mergeConnectionTags, userConnectionTags } from "../../../tags/tagKinds";
import { PasswordInput } from "../../../../components/ui/form/PasswordInput";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { useI18n } from "../../../../i18n";
import {
  commands,
  type Connection,
  type SshConfigEntry,
  type SshKeyInfo,
} from "../../../../ipc/bindings";
import { useConnectionStore } from "../../../../stores/connectionStore";
import {
  buildSshConnection,
  connectionsToForm,
  EMPTY_SERVER_FORM,
  type UnifiedServerFormData,
} from "../../panel/serverConnection";

interface SshConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调；传入新建/更新后的连接 id */
  onSaved?: (connectionId?: string) => void;
  editConnection?: Connection;
}

type CreateSource = "manual" | "config";

function applyConfigEntryToForm(
  prev: UnifiedServerFormData,
  entry: SshConfigEntry,
): UnifiedServerFormData {
  const identity = entry.identityFile?.trim() || "";
  return {
    ...prev,
    name: entry.alias,
    host: entry.hostName,
    port: String(entry.port ?? 22),
    user: entry.user?.trim() || prev.user || "root",
    authType: "privateKey",
    password: "",
    pem: "",
    keyPath: identity || "auto",
    passphrase: "",
  };
}

export function SshConnectionDialog({
  open,
  onClose,
  onSaved,
  editConnection,
}: SshConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const [form, setForm] = useState<UnifiedServerFormData>(EMPTY_SERVER_FORM);
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createSource, setCreateSource] = useState<CreateSource>("manual");
  const [configHosts, setConfigHosts] = useState<SshConfigEntry[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [selectedConfigAlias, setSelectedConfigAlias] = useState("");

  const isEdit = !!editConnection?.id;

  const configHostOptions = useMemo(
    () =>
      configHosts.map((entry) => ({
        value: entry.alias,
        label: entry.alias,
        subtitle: `${entry.user ?? "user"}@${entry.hostName}:${entry.port ?? 22}`,
      })),
    [configHosts],
  );

  const keyOptions = useMemo(() => {
    const options = [
      {
        value: "auto",
        label: t("ssh.dialog.keyAuto"),
        subtitle: t("ssh.dialog.keyAutoHint"),
      },
      ...keys.map((key) => ({
        value: key.id,
        label: key.name,
        subtitle: [key.keyType, key.fingerprint].filter(Boolean).join(" · "),
      })),
    ];
    if (
      form.keyId &&
      !keys.some((key) => key.id === form.keyId)
    ) {
      options.push({
        value: form.keyId,
        label: form.keyId,
        subtitle: t("ssh.dialog.keyMissingHint"),
      });
    }
    return options;
  }, [form.keyId, keys, t]);

  useEffect(() => {
    if (!open) return;
    const base = connectionsToForm(editConnection);
    setForm(base);
    setTags(userConnectionTags(editConnection?.tags));
    setError(null);
    setSaving(false);
    setCreateSource("manual");
    setSelectedConfigAlias("");
    setConfigHosts([]);
    void (async () => {
      const res = await commands.sshListKeys();
      if (res.status === "ok") {
        setKeys(res.data);
      }
    })();
  }, [open, editConnection]);

  useEffect(() => {
    if (!open || isEdit || createSource !== "config") return;
    let cancelled = false;
    setConfigLoading(true);
    void (async () => {
      const res = await commands.sshListConfigHosts();
      if (cancelled) return;
      if (res.status === "ok") {
        setConfigHosts(res.data);
        setError(null);
      } else {
        setConfigHosts([]);
        setError(res.error.message || t("ssh.dialog.configLoadFailed"));
      }
      setConfigLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isEdit, createSource, t]);

  const update = <K extends keyof UnifiedServerFormData>(
    key: K,
    value: UnifiedServerFormData[K],
  ) => {
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const switchCreateSource = (next: CreateSource) => {
    setCreateSource(next);
    setError(null);
    if (next === "manual") {
      setSelectedConfigAlias("");
      setForm((prev) => ({
        ...EMPTY_SERVER_FORM,
        group: prev.group || EMPTY_SERVER_FORM.group,
      }));
    }
  };

  const handleSelectConfigHost = (alias: string) => {
    setSelectedConfigAlias(alias);
    setError(null);
    const entry = configHosts.find((h) => h.alias === alias);
    if (!entry) return;
    setForm((prev) => applyConfigEntryToForm(prev, entry));
  };

  const validate = (): string | null => {
    if (!isEdit && createSource === "config" && !selectedConfigAlias.trim()) {
      return t("ssh.dialog.configHostRequired");
    }
    if (!form.name.trim()) return t("ssh.dialog.nameRequired");
    if (!form.host.trim()) return t("ssh.dialog.hostRequired");
    if (!form.user.trim()) return t("ssh.dialog.userRequired");
    if (form.authType === "password" && !form.password.trim() && !isEdit) {
      return t("ssh.dialog.passwordRequired");
    }
    if (form.authType === "privateKey" && !form.keyId.trim() && !form.keyPath.trim() && !form.pem.trim()) {
      return t("ssh.dialog.keyRequired");
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveConn(
        buildSshConnection(
          form,
          editConnection?.id,
          undefined,
          mergeConnectionTags(tags, editConnection?.tags),
          editConnection,
        ),
      );
      if (!saved) throw new Error("SSH save failed");
      onSaved?.(saved.id);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const showFormFields = isEdit || createSource === "manual" || !!selectedConfigAlias;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("ssh.dialog.editTitle") : t("ssh.dialog.addTitle")}
      size="md"
      onCancel={onClose}
      cancelDisabled={saving}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: saving ? t("ssh.dialog.saving") : isEdit ? t("common.save") : t("ssh.dialog.save"),
        disabled: saving || (!isEdit && createSource === "config" && !selectedConfigAlias),
        onClick: () => void handleSave(),
      }}
    >
      {!isEdit ? (
        <>
          <div className="form-section-title">{t("ssh.dialog.createSource")}</div>
          <div className="form-field">
            <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <button
                type="button"
                className={`engine-chip${createSource === "manual" ? " engine-chip--active" : ""}`}
                onClick={() => switchCreateSource("manual")}
              >
                <span>{t("ssh.dialog.createManual")}</span>
              </button>
              <button
                type="button"
                className={`engine-chip${createSource === "config" ? " engine-chip--active" : ""}`}
                onClick={() => switchCreateSource("config")}
              >
                <span>{t("ssh.dialog.createFromConfig")}</span>
              </button>
            </div>
          </div>
        </>
      ) : null}

      {!isEdit && createSource === "config" ? (
        <div className="form-field">
          <label className="form-label">{t("ssh.dialog.configHost")}</label>
          <Select
            value={selectedConfigAlias}
            onChange={handleSelectConfigHost}
            options={[
              { value: "", label: configLoading ? t("ssh.dialog.configLoading") : t("ssh.dialog.configHostPlaceholder") },
              ...configHostOptions,
            ]}
            searchable={configHosts.length >= 8}
            disabled={configLoading}
            placeholder={t("ssh.dialog.configHostPlaceholder")}
            style={{ width: "100%" }}
          />
          <p className="form-hint">{t("ssh.dialog.configHostHint")}</p>
        </div>
      ) : null}

      {showFormFields ? (
        <>
          <div className="form-section-title">{t("ssh.dialog.sshSection")}</div>

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.name")}</label>
            <TextInput
              placeholder={t("ssh.dialog.namePlaceholder")}
              value={form.name}
              onChange={(value) => update("name", value)}
            />
          </div>

          <div className="form-row">
            <div className="form-field" style={{ flex: 2 }}>
              <label className="form-label">{t("ssh.dialog.host")}</label>
              <TextInput
                placeholder="example.com"
                value={form.host}
                onChange={(value) => update("host", value)}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("ssh.dialog.port")}</label>
              <TextInput
                placeholder="22"
                value={form.port}
                onChange={(value) => update("port", value)}
              />
            </div>
          </div>

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.user")}</label>
            <TextInput
              placeholder="root"
              value={form.user}
              onChange={(value) => update("user", value)}
            />
          </div>

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.authType")}</label>
            <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <button
                type="button"
                className={`engine-chip${form.authType === "password" ? " engine-chip--active" : ""}`}
                onClick={() => update("authType", "password")}
              >
                <span>{t("ssh.dialog.passwordAuth")}</span>
              </button>
              <button
                type="button"
                className={`engine-chip${form.authType === "privateKey" ? " engine-chip--active" : ""}`}
                onClick={() => update("authType", "privateKey")}
              >
                <span>{t("ssh.dialog.keyAuth")}</span>
              </button>
            </div>
          </div>

          {form.authType === "password" ? (
            <div className="form-field">
              <label className="form-label">{t("ssh.dialog.password")}</label>
              <PasswordInput
                copyable
                value={form.password}
                onChange={(value) => update("password", value)}
                placeholder="••••••"
              />
            </div>
          ) : (
            <>
              <div className="form-field">
                <label className="form-label">{t("ssh.dialog.keyPath")}</label>
                <Select
                  value={form.keyId || form.keyPath || "auto"}
                  onChange={(value) => {
                    if (value === "auto") {
                      update("keyId", "");
                      update("keyPath", "auto");
                      return;
                    }
                    const matched = keys.find((key) => key.id === value);
                    if (matched) {
                      update("keyId", matched.id);
                      update("keyPath", "auto");
                      return;
                    }
                    update("keyId", "");
                    update("keyPath", value);
                  }}
                  options={keyOptions}
                  searchable
                  placeholder={t("ssh.dialog.keySelectPlaceholder")}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field">
                <label className="form-label">{t("ssh.dialog.passphrase")}</label>
                <PasswordInput
                  copyable
                  value={form.passphrase}
                  onChange={(value) => update("passphrase", value)}
                  placeholder={t("ssh.dialog.passphrasePlaceholder")}
                />
              </div>
            </>
          )}

          <div className="form-section-title">{t("resourceTags.section")}</div>
          <GlobalTagEditor
            kind="connection"
            resourceId={editConnection?.id ?? ""}
            tags={tags}
            onChange={setTags}
          />
        </>
      ) : null}
    </FormDialog>
  );
}

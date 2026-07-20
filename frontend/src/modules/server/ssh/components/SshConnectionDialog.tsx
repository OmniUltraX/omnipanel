import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { ResourceTagEditor } from "../../../../components/ui/tags/ResourceTagEditor";
import { PasswordInput } from "../../../../components/ui/form/PasswordInput";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { useI18n } from "../../../../i18n";
import { commands, type Connection, type SshKeyInfo } from "../../../../ipc/bindings";
import { collectSshGroupSuggestions } from "../../../../lib/sshGroups";
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
  onSaved?: () => void;
  editConnection?: Connection;
  /** 新建模式下预填的分组名（来自分组右键「新建主机」）。 */
  presetGroup?: string;
}

export function SshConnectionDialog({
  open,
  onClose,
  onSaved,
  editConnection,
  presetGroup,
}: SshConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const connections = useConnectionStore((s) => s.connections);
  const [form, setForm] = useState<UnifiedServerFormData>(EMPTY_SERVER_FORM);
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!editConnection?.id;
  const groupSuggestions = useMemo(
    () => collectSshGroupSuggestions(connections, form.group),
    [connections, form.group],
  );

  const keyOptions = useMemo(() => {
    const options = [
      {
        value: "auto",
        label: t("ssh.dialog.keyAuto"),
        subtitle: t("ssh.dialog.keyAutoHint"),
      },
      ...keys.map((key) => ({
        value: key.path,
        label: key.name,
        subtitle: [key.keyType, key.fingerprint].filter(Boolean).join(" · "),
      })),
    ];
    if (
      form.keyPath &&
      form.keyPath !== "auto" &&
      !keys.some((key) => key.path === form.keyPath)
    ) {
      options.push({
        value: form.keyPath,
        label: form.keyPath,
        subtitle: t("ssh.dialog.keyMissingHint"),
      });
    }
    return options;
  }, [form.keyPath, keys, t]);

  useEffect(() => {
    if (!open) return;
    const base = connectionsToForm(editConnection);
    if (!editConnection?.id && presetGroup) {
      base.group = presetGroup;
    }
    setForm(base);
    setTags(editConnection?.tags ?? []);
    setError(null);
    setSaving(false);
    void (async () => {
      const res = await commands.sshListKeys();
      if (res.status === "ok") {
        setKeys(res.data);
      }
    })();
  }, [open, editConnection, presetGroup]);

  const update = <K extends keyof UnifiedServerFormData>(
    key: K,
    value: UnifiedServerFormData[K],
  ) => {
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("ssh.dialog.nameRequired");
    if (!form.host.trim()) return t("ssh.dialog.hostRequired");
    if (!form.user.trim()) return t("ssh.dialog.userRequired");
    if (form.authType === "password" && !form.password.trim() && !isEdit) {
      return t("ssh.dialog.passwordRequired");
    }
    if (form.authType === "privateKey" && !form.keyPath.trim() && !form.pem.trim()) {
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
        buildSshConnection(form, editConnection?.id, undefined, tags, editConnection),
      );
      if (!saved) throw new Error("SSH save failed");
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

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
        disabled: saving,
        onClick: () => void handleSave(),
      }}
    >
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
              value={form.keyPath || "auto"}
              onChange={(value) => update("keyPath", value)}
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

      <div className="form-field">
        <label className="form-label">{t("ssh.dialog.group")}</label>
        <TextInput
          list="ssh-group-suggestions"
          placeholder={t("ssh.dialog.groupPlaceholder")}
          value={form.group}
          onChange={(value) => update("group", value)}
        />
        <datalist id="ssh-group-suggestions">
          {groupSuggestions.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <p className="form-hint">{t("ssh.dialog.groupHint")}</p>
      </div>

      <div className="form-section-title">{t("resourceTags.section")}</div>
      <ResourceTagEditor tags={tags} onChange={setTags} />
    </FormDialog>
  );
}

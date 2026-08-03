import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { PasswordInput } from "../../../components/ui/form/PasswordInput";
import { TextInput } from "../../../components/ui/form/TextInput";
import { MultiSelect } from "../../../components/ui/form/MultiSelect";
import { useConnectionStore } from "../../../stores/connectionStore";
import { commands } from "../../../ipc/bindings";
import type { Connection } from "../../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../../ipc/result";
import { GlobalTagEditor } from "../../tags/GlobalTagEditor";
import { mergeConnectionTags, userConnectionTags } from "../../tags/tagKinds";
import {
  ALIYUN_REGION_OPTIONS,
  EMPTY_CLOUD_FORM,
  buildCloudConnection,
  cloudConnectionToForm,
  type CloudFormData,
} from "./cloudForm";
import aliyunIcon from "../../../assets/icons/Aliyun.svg";

interface CloudConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editConnection?: Connection;
}

export function CloudConnectionDialog({
  open,
  onClose,
  onSaved,
  editConnection,
}: CloudConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const [form, setForm] = useState<CloudFormData>(EMPTY_CLOUD_FORM);
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const isEdit = !!editConnection?.id;

  useEffect(() => {
    if (!open) return;
    setForm(editConnection ? cloudConnectionToForm(editConnection) : { ...EMPTY_CLOUD_FORM });
    setTags(userConnectionTags(editConnection?.tags));
    setError(null);
    setStatus(null);
    setSaving(false);
    setTesting(false);
  }, [open, editConnection]);

  const update = <K extends keyof CloudFormData>(key: K, value: CloudFormData[K]) => {
    setError(null);
    setStatus(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("server.cloud.create.nameRequired");
    if (form.regions.length === 0) return t("server.cloud.create.regionRequired");
    if (!form.accessKeyId.trim()) return t("server.cloud.create.akRequired");
    if (!isEdit && !form.accessKeySecret.trim()) return t("server.cloud.create.skRequired");
    return null;
  };

  const handleTest = async () => {
    if (!form.accessKeyId.trim()) {
      setStatus({ kind: "error", message: t("server.cloud.create.akRequired") });
      return;
    }
    if (!form.accessKeySecret.trim() && !isEdit) {
      setStatus({ kind: "error", message: t("server.cloud.create.skRequired") });
      return;
    }
    setTesting(true);
    setStatus({ kind: "info", message: t("server.cloud.create.testing") });
    try {
      const draft = buildCloudConnection(form, editConnection);
      const message = await unwrapCommand(
        commands.cloudTest(draft, form.accessKeySecret.trim() || null),
      );
      setStatus({
        kind: "success",
        message: t("server.cloud.create.testSuccess", { detail: message }),
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: t("server.cloud.create.testFailed", { error: formatIpcError(err) }),
      });
    } finally {
      setTesting(false);
    }
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
      const draft = buildCloudConnection(
        form,
        editConnection,
        mergeConnectionTags(tags, editConnection?.tags),
      );
      const saved = await saveConn(draft);
      if (!saved?.id) throw new Error("Cloud save failed");
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const footerStatus = error ? { kind: "error" as const, message: error } : status;
  const regionOptions = ALIYUN_REGION_OPTIONS.map((r) => ({
    value: r.value,
    label: `${r.label} (${r.value})`,
  }));

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("server.cloud.edit.title") : t("server.cloud.create.title")}
      size="md"
      onCancel={onClose}
      cancelDisabled={saving || testing}
      status={footerStatus}
      actions={[
        {
          label: testing ? t("server.cloud.create.testing") : t("server.cloud.create.test"),
          variant: "ghost",
          disabled: saving || testing || !form.accessKeyId.trim(),
          onClick: () => void handleTest(),
        },
      ]}
      primaryAction={{
        label: saving ? t("ssh.dialog.saving") : isEdit ? t("common.save") : t("ssh.dialog.save"),
        disabled: saving || testing,
        onClick: () => void handleSave(),
      }}
    >
      <div className="form-field">
        <label className="form-label">{t("server.cloud.create.name")}</label>
        <TextInput
          placeholder={t("server.cloud.create.namePlaceholder")}
          value={form.name}
          onChange={(value) => update("name", value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.cloud.create.provider")}</label>
        <div className="engine-grid" style={{ gridTemplateColumns: "1fr" }}>
          <button type="button" className="engine-chip engine-chip--active">
            <span className="engine-chip-icon">
              <img src={aliyunIcon} alt="" className="engine-chip-logo" draggable={false} />
            </span>
            <span className="engine-chip-label">{t("server.cloud.providers.aliyun")}</span>
          </button>
        </div>
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.cloud.create.regions")}</label>
        <MultiSelect
          values={form.regions}
          options={regionOptions}
          onChange={(regions) => update("regions", regions)}
          emptyMeansAll={false}
          searchable
          placeholder={t("server.cloud.create.regionsPlaceholder")}
          formatDisplayLabel={(labels, _all) =>
            labels.length === 0
              ? t("server.cloud.create.regionsPlaceholder")
              : t("server.cloud.create.regionsSelected", { count: String(labels.length) })
          }
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.cloud.create.accessKeyId")}</label>
        <TextInput
          placeholder="LTAI..."
          value={form.accessKeyId}
          onChange={(value) => update("accessKeyId", value)}
          autoComplete="off"
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.cloud.create.accessKeySecret")}</label>
        <PasswordInput
          copyable
          value={form.accessKeySecret}
          onChange={(value) => update("accessKeySecret", value)}
          placeholder={
            isEdit ? t("server.cloud.create.secretEditHint") : "••••••••"
          }
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.cloud.create.remark")}</label>
        <TextInput
          placeholder={t("server.cloud.create.remarkPlaceholder")}
          value={form.remark}
          onChange={(value) => update("remark", value)}
        />
      </div>

      <div className="form-section-title">{t("resourceTags.section")}</div>
      <GlobalTagEditor
        kind="connection"
        resourceId={editConnection?.id ?? ""}
        tags={tags}
        onChange={setTags}
      />
    </FormDialog>
  );
}

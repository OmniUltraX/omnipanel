import { useEffect, useState } from "react";
import { FormDialog, FormField } from "../ui/form/FormDialog";
import { TextInput } from "../ui/form/TextInput";
import { PasswordInput } from "../ui/form/PasswordInput";
import { Select } from "../ui/form/Select";
import { useI18n } from "../../i18n";
import type {
  ThirdPartyAccount,
  ThirdPartyAuthMethod,
  ThirdPartyPlatform,
  UpsertThirdPartyAccountInput,
} from "../../stores/thirdPartyAccountsStore";
import {
  THIRD_PARTY_AUTH_METHODS,
  THIRD_PARTY_PLATFORMS,
} from "../../stores/thirdPartyAccountsStore";

interface ThirdPartyAccountDialogProps {
  open: boolean;
  onClose: () => void;
  editAccount?: ThirdPartyAccount | null;
  onSubmit: (input: UpsertThirdPartyAccountInput) => Promise<ThirdPartyAccount | null>;
}

interface FormState {
  name: string;
  platform: ThirdPartyPlatform;
  authMethod: ThirdPartyAuthMethod;
  username: string;
  secret: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  platform: "github",
  authMethod: "api_key",
  username: "",
  secret: "",
  notes: "",
};

export function ThirdPartyAccountDialog({
  open,
  onClose,
  editAccount,
  onSubmit,
}: ThirdPartyAccountDialogProps) {
  const { t } = useI18n();
  const isEdit = Boolean(editAccount);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editAccount) {
      setForm({
        name: editAccount.name,
        platform: editAccount.platform,
        authMethod: editAccount.authMethod,
        username: editAccount.username,
        secret: "",
        notes: editAccount.notes,
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
    setError(null);
    setSubmitting(false);
  }, [open, editAccount]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const handleSubmit = async () => {
    const name = form.name.trim();
    if (!name) {
      setError(t("settings.accounts.errors.nameRequired"));
      return;
    }
    if (form.authMethod === "password" && !form.username.trim()) {
      setError(t("settings.accounts.errors.usernameRequired"));
      return;
    }
    if (!isEdit && !form.secret.trim()) {
      setError(t("settings.accounts.errors.secretRequired"));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const saved = await onSubmit({
        id: editAccount?.id,
        name,
        platform: form.platform,
        authMethod: form.authMethod,
        username: form.username.trim(),
        notes: form.notes.trim(),
        secret: form.secret.trim() ? form.secret.trim() : undefined,
      });
      if (saved) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const platformOptions = THIRD_PARTY_PLATFORMS.map((p) => ({
    value: p,
    label: t(`settings.accounts.platforms.${p}`),
  }));

  const authOptions = THIRD_PARTY_AUTH_METHODS.map((m) => ({
    value: m,
    label: t(`settings.accounts.authMethods.${m}`),
  }));

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("settings.accounts.edit.title") : t("settings.accounts.add.title")}
      subtitle={t("settings.accounts.dialogDesc")}
      size="md"
      closeDisabled={submitting}
      cancelDisabled={submitting}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: isEdit ? t("settings.accounts.save") : t("settings.accounts.add.submit"),
        disabled: submitting,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormField label={t("settings.accounts.fields.name")}>
        <TextInput
          value={form.name}
          placeholder={t("settings.accounts.fields.namePlaceholder")}
          onChange={(name) => updateField("name", name)}
        />
      </FormField>

      <FormField label={t("settings.accounts.fields.platform")}>
        <Select
          value={form.platform}
          options={platformOptions}
          onChange={(platform) => updateField("platform", platform as ThirdPartyPlatform)}
          searchable
        />
      </FormField>

      <FormField label={t("settings.accounts.fields.authMethod")}>
        <Select
          value={form.authMethod}
          options={authOptions}
          onChange={(authMethod) =>
            updateField("authMethod", authMethod as ThirdPartyAuthMethod)
          }
          searchable={false}
        />
      </FormField>

      {form.authMethod === "password" ? (
        <FormField label={t("settings.accounts.fields.username")}>
          <TextInput
            value={form.username}
            placeholder={t("settings.accounts.fields.usernamePlaceholder")}
            onChange={(username) => updateField("username", username)}
            autoComplete="username"
          />
        </FormField>
      ) : null}

      <FormField
        label={
          form.authMethod === "api_key"
            ? t("settings.accounts.fields.apiKey")
            : t("settings.accounts.fields.password")
        }
        hint={
          isEdit && editAccount?.hasSecret
            ? t("settings.accounts.fields.secretEditHint")
            : undefined
        }
      >
        <PasswordInput
          value={form.secret}
          placeholder={
            form.authMethod === "api_key"
              ? t("settings.accounts.fields.apiKeyPlaceholder")
              : t("settings.accounts.fields.passwordPlaceholder")
          }
          onChange={(secret) => updateField("secret", secret)}
        />
      </FormField>

      <FormField label={t("settings.accounts.fields.notes")}>
        <TextInput
          value={form.notes}
          placeholder={t("settings.accounts.fields.notesPlaceholder")}
          onChange={(notes) => updateField("notes", notes)}
        />
      </FormField>
    </FormDialog>
  );
}

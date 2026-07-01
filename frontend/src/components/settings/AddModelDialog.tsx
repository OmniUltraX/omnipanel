import { useEffect, useState } from "react";
import { FormDialog } from "../ui/FormDialog";
import { PasswordInput } from "../ui/PasswordInput";
import { TextInput } from "../ui/TextInput";
import { useI18n } from "../../i18n";
import {
  fetchProviderModelList,
  mergeModelCatalog,
  buildApiModelMeta,
  type ApiModelMeta,
} from "../../lib/fetchProviderModels";
import {
  defaultBaseUrlFor,
  isValidBaseUrl,
  parseModelNames,
  useAiModelsStore,
  type AiModelProvider,
  type ApiStandard,
} from "../../stores/aiModelsStore";

interface AddModelDialogProps {
  open: boolean;
  onClose: () => void;
  /** 传入时为编辑模式 */
  editProvider?: AiModelProvider | null;
  onSaved?: (providerId: string) => void;
}

interface FormState {
  providerName: string;
  modelNames: string;
  apiStandard: ApiStandard;
  baseUrl: string;
  apiKey: string;
  baseUrlTouched: boolean;
}

const EMPTY_FORM: FormState = {
  providerName: "",
  modelNames: "",
  apiStandard: "openai",
  baseUrl: "",
  apiKey: "",
  baseUrlTouched: false,
};

const API_STANDARD_OPTIONS: { value: ApiStandard; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

async function resolveModelCatalog(
  baseUrl: string,
  apiKey: string,
  manualInput: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): Promise<
  | {
      ok: true;
      modelNames: string[];
      manualModelNames: string[];
      apiModelMeta: Record<string, ApiModelMeta>;
      fetchNote: string | null;
    }
  | { ok: false; error: string }
> {
  const parsed = parseModelNames(manualInput);
  if (!parsed.ok) {
    return { ok: false, error: t("settings.aiModels.errors.nameDuplicateInInput", { name: parsed.duplicate }) };
  }

  const manualModelNames = parsed.names;
  const fetchResult = await fetchProviderModelList(baseUrl, apiKey);
  if (fetchResult.ok) {
    const modelNames = mergeModelCatalog(manualModelNames, fetchResult.models);
    if (modelNames.length === 0) {
      return { ok: false, error: t("settings.aiModels.errors.modelNamesRequired") };
    }
    const apiModelMeta = buildApiModelMeta(modelNames, manualModelNames, fetchResult.models);
    const note =
      manualModelNames.length > 0
        ? t("settings.aiModels.fetch.merged", { count: modelNames.length })
        : t("settings.aiModels.fetch.success", { count: modelNames.length });
    return { ok: true, modelNames, manualModelNames, apiModelMeta, fetchNote: note };
  }

  if (manualModelNames.length > 0) {
    return {
      ok: true,
      modelNames: manualModelNames,
      manualModelNames,
      apiModelMeta: {},
      fetchNote: t("settings.aiModels.fetch.fallbackManual"),
    };
  }

  return { ok: false, error: t("settings.aiModels.errors.fetchFailed") };
}

export function AddModelDialog({ open, onClose, editProvider, onSaved }: AddModelDialogProps) {
  const { t } = useI18n();
  const addProvider = useAiModelsStore((s) => s.addProvider);
  const updateProvider = useAiModelsStore((s) => s.updateProvider);

  const isEdit = Boolean(editProvider);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editProvider) {
      setForm({
        providerName: editProvider.providerName,
        modelNames: (editProvider.manualModelNames ?? []).join(", "),
        apiStandard: editProvider.apiStandard,
        baseUrl: editProvider.baseUrl,
        apiKey: "",
        baseUrlTouched: true,
      });
    } else {
      setForm({ ...EMPTY_FORM, baseUrl: defaultBaseUrlFor(EMPTY_FORM.apiStandard) });
    }
    setError(null);
    setInfo(null);
    setSaving(false);
  }, [open, editProvider]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
    setInfo(null);
  };

  const handleStandardChange = (next: ApiStandard) => {
    setForm((prev) => ({
      ...prev,
      apiStandard: next,
      baseUrl:
        prev.baseUrlTouched && prev.baseUrl && prev.baseUrl !== defaultBaseUrlFor(prev.apiStandard)
          ? prev.baseUrl
          : defaultBaseUrlFor(next),
    }));
    setError(null);
    setInfo(null);
  };

  const submit = async () => {
    const providerName = form.providerName.trim();
    const baseUrl = form.baseUrl.trim();
    const apiKey = form.apiKey.trim();

    if (!providerName) {
      setError(t("settings.aiModels.errors.providerNameRequired"));
      return;
    }
    if (!isValidBaseUrl(baseUrl)) {
      setError(t("settings.aiModels.errors.baseUrlInvalid"));
      return;
    }

    if (isEdit && editProvider) {
      const effectiveKey = apiKey || editProvider.apiKey;
      if (!effectiveKey) {
        setError(t("settings.aiModels.errors.apiKeyRequired"));
        return;
      }

      setSaving(true);
      setError(null);
      setInfo(t("settings.aiModels.fetch.loading"));

      const catalog = await resolveModelCatalog(baseUrl, effectiveKey, form.modelNames, t);
      setSaving(false);
      if (!catalog.ok) {
        setError(catalog.error);
        setInfo(null);
        return;
      }
      updateProvider(editProvider.id, {
        providerName,
        modelNames: catalog.modelNames,
        manualModelNames: catalog.manualModelNames,
        apiModelMeta: catalog.apiModelMeta,
        apiStandard: form.apiStandard,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        disabledModelNames: (editProvider.disabledModelNames ?? []).filter((name) =>
          catalog.modelNames.includes(name),
        ),
      });
      onSaved?.(editProvider.id);
      onClose();
      return;
    }

    if (!apiKey) {
      setError(t("settings.aiModels.errors.apiKeyRequired"));
      return;
    }

    setSaving(true);
    setError(null);
    setInfo(t("settings.aiModels.fetch.loading"));

    const catalog = await resolveModelCatalog(baseUrl, apiKey, form.modelNames, t);
    setSaving(false);
    if (!catalog.ok) {
      setError(catalog.error);
      setInfo(null);
      return;
    }
    const created = addProvider({
      providerName,
      modelNames: catalog.modelNames,
      manualModelNames: catalog.manualModelNames,
      apiModelMeta: catalog.apiModelMeta,
      apiStandard: form.apiStandard,
      baseUrl,
      apiKey,
      disabledModelNames: [],
    });
    onSaved?.(created.id);
    onClose();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("settings.aiModels.edit.title") : t("settings.aiModels.add.title")}
      subtitle={isEdit ? t("settings.aiModels.edit.subtitle") : t("settings.aiModels.add.subtitle")}
      titleId="add-model-title"
      size="sm"
      bodyClassName="add-model-body"
      cancelLabel={t("settings.aiModels.add.cancel")}
      cancelVariant="ghost"
      primaryAction={{
        label: saving
          ? t("settings.aiModels.fetch.saving")
          : isEdit
            ? t("settings.aiModels.edit.confirm")
            : t("settings.aiModels.add.confirm"),
        disabled: saving,
        onClick: () => void submit(),
      }}
    >
      <div className="form-field">
        <label htmlFor="add-model-provider">{t("settings.aiModels.fields.providerName")}</label>
        <TextInput
          id="add-model-provider"
          className="input"
          autoFocus
          value={form.providerName}
          onChange={(value) => updateField("providerName", value)}
          placeholder={t("settings.aiModels.fields.providerNamePlaceholder")}
          disabled={saving}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      <div className="form-field">
        <label htmlFor="add-model-names">{t("settings.aiModels.fields.modelNames")}</label>
        <TextInput
          id="add-model-names"
          className="input"
          value={form.modelNames}
          onChange={(value) => updateField("modelNames", value)}
          placeholder={t("settings.aiModels.fields.modelNamesPlaceholder")}
          disabled={saving}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="form-field-hint">{t("settings.aiModels.fields.modelNamesHint")}</div>
      </div>

      <div className="form-field">
        <span id="add-model-standard-label" className="form-label">
          {t("settings.aiModels.fields.standard")}
        </span>
        <div
          className="form-radio-group"
          role="radiogroup"
          aria-labelledby="add-model-standard-label"
        >
          {API_STANDARD_OPTIONS.map((option) => (
            <label key={option.value} className="form-radio-option">
              <input
                type="radio"
                name="add-model-api-standard"
                value={option.value}
                checked={form.apiStandard === option.value}
                disabled={saving}
                onChange={() => handleStandardChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="add-model-baseurl">{t("settings.aiModels.fields.baseUrl")}</label>
        <TextInput
          id="add-model-baseurl"
          className="input"
          value={form.baseUrl}
          disabled={saving}
          onChange={(baseUrl) =>
            setForm((p) => ({ ...p, baseUrl, baseUrlTouched: true }))
          }
          placeholder={defaultBaseUrlFor(form.apiStandard)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      <div className="form-field">
        <label htmlFor="add-model-apikey">{t("settings.aiModels.fields.apiKey")}</label>
        <PasswordInput
          copyable
          id="add-model-apikey"
          autoComplete="off"
          spellCheck={false}
          value={form.apiKey}
          disabled={saving}
          onChange={(value) => updateField("apiKey", value)}
          placeholder={
            isEdit
              ? t("settings.aiModels.fields.apiKeyPlaceholderEdit")
              : t("settings.aiModels.fields.apiKeyPlaceholder")
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="form-field-hint">
          {isEdit ? t("settings.aiModels.fields.apiKeyHintEdit") : t("settings.aiModels.fields.apiKeyHint")}
        </div>
      </div>

      {info && !error && <div className="form-field-hint">{info}</div>}
      {error && <div className="form-error">{error}</div>}
    </FormDialog>
  );
}

import { FormField } from "../../components/ui/form/FormField";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { Select } from "../../components/ui/form/Select";
import { TextInput } from "../../components/ui/form/TextInput";
import type { PluginSettingsField } from "../../lib/pluginConfiguration";

type Props = {
  fields: PluginSettingsField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
};

export function PluginSettingsForm({ fields, values, onChange, disabled }: Props) {
  if (fields.length === 0) return null;

  return (
    <div className="plugin-settings-form">
      {fields.map((field) => {
        const value = values[field.key] ?? "";
        const desc = field.description;
        const label =
          field.source === "field" && field.required ? `${field.label} *` : field.label;

        if (field.kind === "boolean" || field.kind === "checkbox") {
          return (
            <FormField key={field.key} layout="horizontal" label={label} hint={desc}>
              <input
                type="checkbox"
                checked={value === "true" || value === "1"}
                disabled={disabled}
                onChange={(e) => onChange(field.key, e.target.checked ? "true" : "false")}
              />
            </FormField>
          );
        }

        return (
          <FormField key={field.key} layout="horizontal" label={label} hint={desc}>
            {field.kind === "enum" && field.source === "property" ? (
              <Select
                value={value}
                disabled={disabled}
                onChange={(next) => onChange(field.key, next)}
                options={(field.enumValues ?? []).map((item) => ({
                  value: String(item),
                  label: String(item),
                }))}
                style={{ width: "100%" }}
              />
            ) : field.kind === "password" || field.kind === "secret" ? (
              <PasswordInput
                copyable
                value={value}
                disabled={disabled}
                onChange={(next) => onChange(field.key, next)}
                placeholder={
                  field.source === "field"
                    ? field.placeholder
                    : value
                      ? undefined
                      : "••••••"
                }
              />
            ) : (
              <TextInput
                value={value}
                disabled={disabled}
                onChange={(next) => onChange(field.key, next)}
                placeholder={field.source === "field" ? field.placeholder : undefined}
                inputMode={field.kind === "number" ? "decimal" : undefined}
              />
            )}
          </FormField>
        );
      })}
    </div>
  );
}

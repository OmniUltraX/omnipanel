import { useId, useMemo } from "react";
import { Select } from "../../components/ui/form/Select";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import {
  HTTP_HEADER_VALUE_TYPES,
  type HttpHeaderPair,
  type HttpHeaderValueType,
} from "./httpHeaderUtils";
import { HTTP_HEADER_KEYS, headerValueOptions } from "./httpHeaderPresets";

interface Props {
  pair: HttpHeaderPair;
  onChange: (patch: Partial<HttpHeaderPair>) => void;
  onRemove: () => void;
}

interface HttpHeaderComboFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
  pickTitle: string;
  disabled?: boolean;
  showPicker?: boolean;
}

/** 请求头值：TextInput 自定义输入 + 预设下拉选择 + datalist 补全 */
function HttpHeaderComboField({
  value,
  onChange,
  options,
  placeholder,
  pickTitle,
  disabled = false,
  showPicker = true,
}: HttpHeaderComboFieldProps) {
  const listId = useId();
  const presetOptions = useMemo(
    () => options.filter((item) => item.trim().length > 0),
    [options],
  );

  return (
    <div className={`kv-combo${disabled ? " kv-combo--disabled" : ""}`}>
      <TextInput
        copyable={false}
        clearable={false}
        size="sm"
        className="kv-combo__input"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        list={!disabled && presetOptions.length > 0 ? listId : undefined}
        aria-label={placeholder}
        disabled={disabled}
      />
      {presetOptions.length > 0 ? (
        <datalist id={listId}>
          {presetOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
      {!disabled && showPicker && presetOptions.length > 0 ? (
        <Select
          className="kv-combo__pick"
          size="sm"
          borderless
          value=""
          onChange={onChange}
          options={presetOptions}
          placeholder="▾"
          title={pickTitle}
          aria-label={pickTitle}
          searchable
        />
      ) : null}
    </div>
  );
}

function valueTypeLabel(
  valueType: HttpHeaderValueType,
  t: (key: string) => string,
): string {
  switch (valueType) {
    case "current_unix_timestamp":
      return t("protocol.http.headerValueTypes.currentUnixTimestamp");
    case "base64":
      return t("protocol.http.headerValueTypes.base64");
    default:
      return t("protocol.http.headerValueTypes.string");
  }
}

export function HttpHeaderKvRow({ pair, onChange, onRemove }: Props) {
  const { t } = useI18n();

  const valueOptions = useMemo(
    () => headerValueOptions(pair.key, pair.value),
    [pair.key, pair.value],
  );

  const valueTypeOptions = useMemo(
    () =>
      HTTP_HEADER_VALUE_TYPES.map((valueType) => ({
        value: valueType,
        label: valueTypeLabel(valueType, t),
      })),
    [t],
  );

  const valueDisabled = pair.valueType === "current_unix_timestamp";
  const valuePlaceholder =
    pair.valueType === "current_unix_timestamp"
      ? t("protocol.http.headerValueAutoTimestamp")
      : pair.valueType === "base64"
        ? t("protocol.http.headerValueBase64Input")
        : t("protocol.common.value");

  return (
    <div className="kv-row kv-row--header">
      <input
        type="checkbox"
        className="kv-check"
        checked={pair.enabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
      />
      {pair.keyKind === "preset" ? (
        <Select
          className="kv-select kv-select--header-key"
          size="sm"
          value={pair.key}
          onChange={(key) => onChange({ key })}
          options={[...HTTP_HEADER_KEYS]}
          placeholder={t("protocol.http.pickHeaderKey")}
          searchable
          aria-label={t("protocol.common.key")}
        />
      ) : (
        <TextInput
          copyable={false}
          clearable={false}
          size="sm"
          className="kv-input kv-input--header-key"
          value={pair.key}
          onChange={(key) => onChange({ key })}
          placeholder={t("protocol.http.customHeaderKey")}
          aria-label={t("protocol.common.key")}
        />
      )}
      <Select
        className="kv-select kv-select--value-type"
        size="sm"
        value={pair.valueType}
        onChange={(valueType) =>
          onChange({ valueType: valueType as HttpHeaderValueType })
        }
        options={valueTypeOptions}
        aria-label={t("protocol.http.headerValueType")}
      />
      {pair.valueType === "string" && pair.keyKind === "preset" ? (
        <HttpHeaderComboField
          value={pair.value}
          onChange={(value) => onChange({ value })}
          options={valueOptions}
          placeholder={valuePlaceholder}
          pickTitle={t("protocol.http.pickHeaderValue")}
        />
      ) : (
        <TextInput
          copyable={false}
          clearable={false}
          size="sm"
          className="kv-input kv-input--header-value"
          value={pair.value}
          onChange={(value) => onChange({ value })}
          placeholder={valuePlaceholder}
          aria-label={t("protocol.common.value")}
          disabled={valueDisabled}
        />
      )}
      <div className="kv-del" onClick={onRemove}>
        {"×"}
      </div>
    </div>
  );
}

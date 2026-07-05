import { useId, useMemo } from "react";
import { Select } from "../../components/ui/form/Select";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import type { HttpKvPair } from "./ProtocolHttpContext";
import { headerKeyOptions, headerValueOptions } from "./httpHeaderPresets";

interface Props {
  pair: HttpKvPair;
  onChange: (patch: Partial<HttpKvPair>) => void;
  onRemove: () => void;
}

interface HttpHeaderComboFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
  pickTitle: string;
  showPicker?: boolean;
}

/** 请求头键/值：TextInput 自定义输入 + 预设下拉选择 + datalist 补全 */
function HttpHeaderComboField({
  value,
  onChange,
  options,
  placeholder,
  pickTitle,
  showPicker = true,
}: HttpHeaderComboFieldProps) {
  const listId = useId();
  const presetOptions = useMemo(
    () => options.filter((item) => item.trim().length > 0),
    [options],
  );

  return (
    <div className="kv-combo">
      <TextInput
        copyable={false}
        clearable={false}
        size="sm"
        className="kv-combo__input"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        list={presetOptions.length > 0 ? listId : undefined}
        aria-label={placeholder}
      />
      {presetOptions.length > 0 ? (
        <datalist id={listId}>
          {presetOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
      {showPicker && presetOptions.length > 0 ? (
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

export function HttpHeaderKvRow({ pair, onChange, onRemove }: Props) {
  const { t } = useI18n();

  const keyOptions = useMemo(() => headerKeyOptions(pair.key), [pair.key]);
  const valueOptions = useMemo(
    () => headerValueOptions(pair.key, pair.value),
    [pair.key, pair.value],
  );

  return (
    <div className="kv-row">
      <input
        type="checkbox"
        className="kv-check"
        checked={pair.enabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
      />
      <HttpHeaderComboField
        value={pair.key}
        onChange={(key) => onChange({ key })}
        options={keyOptions}
        placeholder={t("protocol.common.key")}
        pickTitle={t("protocol.http.pickHeaderKey")}
      />
      <HttpHeaderComboField
        value={pair.value}
        onChange={(value) => onChange({ value })}
        options={valueOptions}
        placeholder={t("protocol.common.value")}
        pickTitle={t("protocol.http.pickHeaderValue")}
      />
      <div className="kv-del" onClick={onRemove}>
        {"×"}
      </div>
    </div>
  );
}

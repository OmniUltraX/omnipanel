import { useMemo } from "react";
import { Select } from "../../components/ui/Select";
import { useI18n } from "../../i18n";
import type { HttpKvPair } from "./ProtocolHttpContext";
import { headerKeyOptions, headerValueOptions } from "./httpHeaderPresets";

interface Props {
  pair: HttpKvPair;
  onChange: (patch: Partial<HttpKvPair>) => void;
  onRemove: () => void;
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
      <Select
        className="kv-select"
        size="sm"
        borderless
        value={pair.key}
        onChange={(key) => onChange({ key })}
        options={keyOptions}
        placeholder={t("protocol.common.key")}
        searchable
      />
      <Select
        className="kv-select"
        size="sm"
        borderless
        value={pair.value}
        onChange={(value) => onChange({ value })}
        options={valueOptions}
        placeholder={t("protocol.common.value")}
        searchable
      />
      <div className="kv-del" onClick={onRemove}>
        {"×"}
      </div>
    </div>
  );
}

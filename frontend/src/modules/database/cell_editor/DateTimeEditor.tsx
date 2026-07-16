import { TemporalInput } from "./TemporalInput";

interface DateTimeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

/** 与二进制日志筛选相同的原生 datetime-local 控件 */
export function DateTimeEditor({ value, onChange, autoFocus = true }: DateTimeEditorProps) {
  return (
    <TemporalInput
      type="datetime-local"
      className="cell-editor-input cell-editor-input--datetime"
      value={value}
      onChange={onChange}
      autoFocus={autoFocus}
    />
  );
}

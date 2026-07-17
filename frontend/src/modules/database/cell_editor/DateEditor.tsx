import { TemporalInput } from "./TemporalInput";

interface DateEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function DateEditor({ value, onChange, autoFocus = true }: DateEditorProps) {
  return (
    <TemporalInput
      type="date"
      className="cell-editor-input cell-editor-input--date"
      value={value}
      onChange={onChange}
      autoFocus={autoFocus}
    />
  );
}

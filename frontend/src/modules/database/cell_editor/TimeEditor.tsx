import { TemporalInput } from "./TemporalInput";

interface TimeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function TimeEditor({ value, onChange, autoFocus = true }: TimeEditorProps) {
  return (
    <TemporalInput
      type="time"
      className="cell-editor-input cell-editor-input--time"
      value={value}
      onChange={onChange}
      autoFocus={autoFocus}
    />
  );
}

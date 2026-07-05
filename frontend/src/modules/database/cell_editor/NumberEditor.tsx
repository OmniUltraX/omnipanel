import { useRef, useEffect } from "react";
import { TextInput } from "../../../components/ui/form/TextInput";

interface NumberEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function NumberEditor({ value, onChange, autoFocus = true }: NumberEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);
  return (
    <TextInput
      ref={ref}
      clearable={false}
      copyable={false}
      inputMode="decimal"
      className="cell-editor-input"
      value={value}
      onChange={onChange}
    />
  );
}

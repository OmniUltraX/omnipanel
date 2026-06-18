import { useRef, useEffect } from "react";

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
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      className="cell-editor-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

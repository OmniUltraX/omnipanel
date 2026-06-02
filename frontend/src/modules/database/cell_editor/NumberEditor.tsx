import { useRef, useEffect } from "react";

interface NumberEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function NumberEditor({ value, onChange }: NumberEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
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

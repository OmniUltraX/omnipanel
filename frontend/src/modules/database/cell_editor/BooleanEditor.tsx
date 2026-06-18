import { useRef, useEffect } from "react";

interface BooleanEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function BooleanEditor({ value, onChange, autoFocus = true }: BooleanEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const checked = value === "true" || value === "1";
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
  return (
    <label className="cell-editor-boolean">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
      />
      <span>{checked ? "true" : "false"}</span>
    </label>
  );
}

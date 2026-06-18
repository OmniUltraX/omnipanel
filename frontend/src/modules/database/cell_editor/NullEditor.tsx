import { useRef, useEffect } from "react";

interface NullEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function NullEditor({ value, onChange, autoFocus = true }: NullEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
  return (
    <div className="cell-editor-null">
      <span className="cell-editor-null-badge">NULL</span>
      <input
        ref={ref}
        type="text"
        className="cell-editor-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter new value…"
      />
    </div>
  );
}

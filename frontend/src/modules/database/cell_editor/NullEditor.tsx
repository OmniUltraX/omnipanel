import { useRef, useEffect } from "react";

interface NullEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function NullEditor({ value, onChange }: NullEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
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

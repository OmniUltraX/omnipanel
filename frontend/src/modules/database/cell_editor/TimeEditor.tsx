import { useRef, useEffect } from "react";

interface TimeEditorProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Time-only editor using native <input type="time">.
 * Value format: HH:MM (24-hour).
 */
export function TimeEditor({ value, onChange }: TimeEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <input
      ref={ref}
      type="time"
      className="cell-editor-input cell-editor-input--time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

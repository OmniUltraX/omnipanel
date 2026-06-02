import { useRef, useEffect } from "react";

interface DateEditorProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Date-only editor using native <input type="date">.
 * Accepts YYYY-MM-DD and shows the browser's date picker.
 */
export function DateEditor({ value, onChange }: DateEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <input
      ref={ref}
      type="date"
      className="cell-editor-input cell-editor-input--date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

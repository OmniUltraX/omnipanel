import { useRef, useEffect } from "react";

interface DateEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

/**
 * Date-only editor using native <input type="date">.
 * Accepts YYYY-MM-DD and shows the browser's date picker.
 */
export function DateEditor({ value, onChange, autoFocus = true }: DateEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
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

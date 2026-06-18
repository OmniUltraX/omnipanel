import { useRef, useEffect } from "react";

interface DateTimeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

/**
 * Datetime / timestamp editor using native <input type="datetime-local">.
 * Value format: YYYY-MM-DDTHH:MM (browser native format).
 */
export function DateTimeEditor({ value, onChange, autoFocus = true }: DateTimeEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      type="datetime-local"
      className="cell-editor-input cell-editor-input--datetime"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

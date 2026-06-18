import { useRef, useEffect } from "react";

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function JsonEditor({ value, onChange, autoFocus = true }: JsonEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      className="cell-editor-textarea cell-editor-textarea--json"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  );
}

import { useRef, useEffect } from "react";

interface TextEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function TextEditor({ value, onChange, autoFocus = true }: TextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      className="cell-editor-textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  );
}

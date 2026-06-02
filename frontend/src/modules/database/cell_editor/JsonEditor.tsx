import { useRef, useEffect } from "react";

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function JsonEditor({ value, onChange }: JsonEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
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

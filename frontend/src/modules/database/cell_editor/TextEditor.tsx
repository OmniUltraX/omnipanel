import { useRef, useEffect } from "react";

interface TextEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function TextEditor({ value, onChange }: TextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
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

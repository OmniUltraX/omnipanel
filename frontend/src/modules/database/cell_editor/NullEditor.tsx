import { useRef, useEffect } from "react";
import { TextInput } from "../../../components/ui/form/TextInput";

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
      <TextInput
        ref={ref}
        clearable={false}
        copyable={false}
        className="cell-editor-input"
        value={value}
        onChange={onChange}
        placeholder="Enter new value…"
      />
    </div>
  );
}

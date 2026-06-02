interface BooleanEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function BooleanEditor({ value, onChange }: BooleanEditorProps) {
  const checked = value === "true" || value === "1";
  return (
    <label className="cell-editor-boolean">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
      />
      <span>{checked ? "true" : "false"}</span>
    </label>
  );
}

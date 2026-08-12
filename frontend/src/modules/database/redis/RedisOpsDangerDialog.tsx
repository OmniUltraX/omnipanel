import { useState } from "react";
import { Modal } from "../../../components/ui/overlay/Modal";
import { Button } from "../../../components/ui/primitives/Button";
import { TextInput } from "../../../components/ui/form/TextInput";

interface RedisOpsDangerDialogProps {
  open: boolean;
  title: string;
  description: string;
  command: string;
  confirmPhrase: string;
  prodWarning?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RedisOpsDangerDialog({
  open,
  title,
  description,
  command,
  confirmPhrase,
  prodWarning,
  onConfirm,
  onCancel,
}: RedisOpsDangerDialogProps) {
  const [input, setInput] = useState("");
  const canConfirm = input.trim() === confirmPhrase;

  if (!open) {
    return null;
  }

  return (
    <Modal open onClose={onCancel}>
      <div className="redis-ops-danger-dialog">
        <div className="redis-ops-danger-dialog__header">
          <div className="redis-ops-danger-dialog__title">{title}</div>
          <div className="redis-ops-danger-dialog__desc">{description}</div>
        </div>
        {prodWarning ? (
          <div className="redis-ops-danger-dialog__prod">{prodWarning}</div>
        ) : null}
        <pre className="redis-ops-danger-dialog__cmd">{command}</pre>
        <label className="redis-ops-danger-dialog__label">
          输入 <code>{confirmPhrase}</code> 以确认
        </label>
        <TextInput value={input} onChange={setInput} autoFocus />
        <div className="redis-ops-danger-dialog__actions">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" size="sm" disabled={!canConfirm} onClick={onConfirm}>
            确认执行
          </Button>
        </div>
      </div>
    </Modal>
  );
}

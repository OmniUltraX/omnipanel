import { QuickInputDialog } from "./QuickInputDialog";
import { useQuickInputStore } from "../../../stores/quickInputStore";

export function QuickInputHost() {
  const request = useQuickInputStore((state) => state.request);
  const confirm = useQuickInputStore((state) => state.confirm);
  const cancel = useQuickInputStore((state) => state.cancel);

  if (!request) {
    return null;
  }

  return (
    <QuickInputDialog
      open
      title={request.title}
      subtitle={request.subtitle}
      placeholder={request.placeholder}
      defaultValue={request.defaultValue}
      validate={request.validate}
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}

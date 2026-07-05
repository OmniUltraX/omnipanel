import { useToastStore } from "../../../stores/toastStore";

export function ToastHost() {
  const message = useToastStore((state) => state.message);
  const visible = useToastStore((state) => state.visible);

  if (!message) {
    return null;
  }

  return (
    <div className="app-toast-host" aria-live="polite" aria-atomic="true">
      <div className={`app-toast${visible ? " app-toast--visible" : " app-toast--hidden"}`}>
        {message}
      </div>
    </div>
  );
}

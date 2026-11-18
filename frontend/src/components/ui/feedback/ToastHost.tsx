import { useToastStore } from "../../../stores/toastStore";

export function ToastHost() {
  const message = useToastStore((state) => state.message);
  const tone = useToastStore((state) => state.tone);
  const visible = useToastStore((state) => state.visible);

  if (!message) {
    return null;
  }

  return (
    <div className="app-toast-host" aria-live="polite" aria-atomic="true">
      <div
        className={`app-toast app-toast--${tone}${visible ? " app-toast--visible" : " app-toast--hidden"}`}
        role={tone === "error" || tone === "warning" ? "alert" : "status"}
      >
        {message}
      </div>
    </div>
  );
}

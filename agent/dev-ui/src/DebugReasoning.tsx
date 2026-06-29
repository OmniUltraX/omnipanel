import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

export const DebugReasoning: ReasoningMessagePartComponent = ({ text, status }) => {
  const streaming = status?.type === "running";
  const [expanded, setExpanded] = useState(false);
  const open = streaming || expanded;

  if (!text?.trim() && !streaming) return null;

  return (
    <details
      className={`debug-reasoning${streaming ? " debug-reasoning--streaming" : ""}`}
      open={open}
      onToggle={(event) => {
        if (!streaming) {
          setExpanded(event.currentTarget.open);
        }
      }}
    >
      <summary className="debug-reasoning__summary">
        <BrainIcon size={14} className="debug-reasoning__icon" />
        <span>{streaming ? "正在思考…" : "思考过程"}</span>
        <ChevronDownIcon size={14} className="debug-reasoning__chevron" />
      </summary>
      <div className="debug-reasoning__body">
        {text}
        {streaming ? <span className="debug-reasoning__cursor" aria-hidden /> : null}
      </div>
    </details>
  );
};

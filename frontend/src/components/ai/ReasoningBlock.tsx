import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";

interface ReasoningBlockProps {
  content: string;
  isStreaming?: boolean;
  hasAnswer?: boolean;
}

function ReasoningIcon() {
  return (
    <svg
      className="ai-reasoning-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      width="14"
      height="14"
      aria-hidden
    >
      <path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.2 6" strokeLinecap="round" />
      <path d="M12 22v-3" strokeLinecap="round" />
      <path d="M9 19h6" strokeLinecap="round" />
      <path d="M8.5 14.5c.8-1.2 2.2-2 3.5-2s2.7.8 3.5 2" strokeLinecap="round" />
      <circle cx="9.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 推理模型思考过程 — 可折叠、流式 shimmer */
export function ReasoningBlock({ content, isStreaming, hasAnswer }: ReasoningBlockProps) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const userToggled = useRef(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (userToggled.current) return;
    if (isStreaming) {
      setExpanded(true);
    } else if (hasAnswer) {
      setExpanded(false);
    }
  }, [isStreaming, hasAnswer]);

  useEffect(() => {
    if (expanded && isStreaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, expanded, isStreaming]);

  if (!content && !isStreaming) return null;

  const toggle = () => {
    userToggled.current = true;
    setExpanded((v) => !v);
  };

  return (
    <div
      className={`ai-reasoning${isStreaming ? " is-streaming" : ""}${expanded ? " is-expanded" : ""}`}
    >
      <div className="ai-reasoning-glow" aria-hidden />
      <button type="button" className="ai-reasoning-header" onClick={toggle}>
        <span className="ai-reasoning-badge">
          <ReasoningIcon />
          <span className="ai-reasoning-badge-text">
            {isStreaming ? t("ai.reasoning.thinking") : t("ai.reasoning.label")}
          </span>
          {isStreaming && (
            <span className="ai-reasoning-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          )}
        </span>
        <span className="ai-reasoning-meta">
          {!expanded && content && (
            <span className="ai-reasoning-preview">
              {content.length > 48 ? `${content.slice(0, 48)}…` : content}
            </span>
          )}
          <span className="ai-reasoning-chevron" aria-hidden>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </span>
      </button>

      <div className="ai-reasoning-body-wrap">
        <div ref={bodyRef} className="ai-reasoning-body">
          <p className="ai-reasoning-text">
            {content}
            {isStreaming && <span className="ai-reasoning-cursor" />}
          </p>
        </div>
      </div>
    </div>
  );
}

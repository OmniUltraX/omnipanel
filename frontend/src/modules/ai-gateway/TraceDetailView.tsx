import { useEffect, useState } from "react";

import { commands, type AiTraceRecord } from "../../ipc/bindings";
import { isTauriRuntime } from "../../lib/isTauriRuntime";

function formatTracePayload(trace: AiTraceRecord): string {
  if (trace.eventType !== "prompt_sent") {
    return trace.payload;
  }
  try {
    const parsed = JSON.parse(trace.payload) as { round?: number; prompt?: string };
    const round = parsed.round ?? "?";
    const prompt = parsed.prompt ?? "";
    return `[Round ${round}]\n${prompt}`;
  } catch {
    return trace.payload;
  }
}

function traceEventLabel(eventType: string): string {
  if (eventType === "prompt_sent") return "Prompt 发送";
  return eventType;
}

export function TraceDetailView({ sessionId }: { sessionId: string }) {
  const [traces, setTraces] = useState<AiTraceRecord[]>([]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void commands
      .aiListSessionTraces(sessionId)
      .then((res) => {
        if (res.status === "ok") {
          setTraces(res.data);
        } else {
          setTraces([]);
        }
      })
      .catch(() => setTraces([]));
  }, [sessionId]);

  return (
    <div className="ai-trace-detail">
      <h3 className="settings-subsection-title">Session: {sessionId}</h3>
      <ul className="ai-trace-timeline">
        {traces.map((trace) => (
          <li
            key={trace.id}
            className={`ai-trace-event${trace.eventType === "prompt_sent" ? " ai-trace-event--prompt" : ""}`}
          >
            <div className="ai-trace-event-head">
              <span>{traceEventLabel(trace.eventType)}</span>
              <span className="section-desc">
                turn {trace.turnIndex} · {new Date(trace.ts ?? 0).toLocaleString()}
              </span>
            </div>
            <pre className="settings-code-block ai-trace-payload">
              {formatTracePayload(trace)}
            </pre>
          </li>
        ))}
        {traces.length === 0 ? <li className="section-desc">无 trace 事件</li> : null}
      </ul>
    </div>
  );
}

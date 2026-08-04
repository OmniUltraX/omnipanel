import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import type { SseEventItem } from "./useSseSession";

interface Props {
  events: SseEventItem[];
  connected: boolean;
  onClear: () => void;
}

/** SSE 事件流列表（单向，无发送区） */
export function HttpSsePanel({ events, connected, onClear }: Props) {
  const { t } = useI18n();

  return (
    <div className="http-sse-panel">
      <div className="http-sse-panel__toolbar">
        <span className="http-sse-panel__count">
          {t("protocol.common.messages", { count: events.length })}
        </span>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={events.length === 0}>
          {t("protocol.common.clearMessages")}
        </Button>
        {connected ? (
          <span className="badge badge-success">{t("protocol.common.connected")}</span>
        ) : null}
      </div>
      <div className="http-sse-panel__events">
        {events.length === 0 ? (
          <div className="http-ws-empty">{t("protocol.sse.noEvents")}</div>
        ) : (
          events.map((item, i) => (
            <div className="sse-event" key={`${item.time}-${i}-${item.id}`}>
              <span className="sse-event__time">{item.time}</span>
              <span className="sse-event__name" title={item.event}>
                {item.event || "message"}
              </span>
              {item.id ? (
                <span className="sse-event__id" title={`id: ${item.id}`}>
                  #{item.id}
                </span>
              ) : null}
              <pre className="sse-event__data">{item.data}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

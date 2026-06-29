import { useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import type { WsMessage } from "./useWebSocketSession";

type WsMsgFormat = "JSON" | "Text" | "Binary";

interface Props {
  messages: WsMessage[];
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  connected: boolean;
}

export function HttpWebSocketPanel({
  messages,
  inputValue,
  onInputChange,
  onSend,
  connected,
}: Props) {
  const { t } = useI18n();
  const [msgFormat, setMsgFormat] = useState<WsMsgFormat>("JSON");

  return (
    <div className="http-ws-panel">
      <div className="ws-messages">
        {messages.length === 0 ? (
          <div className="http-ws-empty">{t("protocol.common.noMessages")}</div>
        ) : (
          messages.map((msg, i) => (
            <div className="ws-msg" key={i}>
              <span className={`ws-dir ${msg.direction}`}>{msg.direction === "out" ? "↑" : "↓"}</span>
              <span className="ws-time">{msg.time}</span>
              <span className="ws-data">{msg.data}</span>
            </div>
          ))
        )}
      </div>

      <div className="ws-input-row">
        <Select
          className="input"
          size="sm"
          style={{ width: "80px" }}
          value={msgFormat}
          onChange={(v) => setMsgFormat(v as WsMsgFormat)}
          searchable={false}
          options={[
            { value: "JSON", label: t("protocol.ws.formats.JSON") },
            { value: "Text", label: t("protocol.ws.formats.Text") },
            { value: "Binary", label: t("protocol.ws.formats.Binary") },
          ]}
        />
        <input
          placeholder={t("protocol.ws.inputPlaceholder")}
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void onSend()}
          disabled={!connected}
        />
        <Button variant="primary" size="sm" onClick={() => void onSend()} disabled={!connected}>
          {t("protocol.common.send")}
        </Button>
      </div>
    </div>
  );
}

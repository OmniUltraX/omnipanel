import { useState, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";

type SerialStatus = "disconnected" | "connecting" | "connected";
type Encoding = "UTF-8" | "ASCII" | "HEX";

interface SerialConfig {
  portName: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  flowControl: string;
}

interface PortInfo {
  port_name: string;
  port_type: string;
  vendor_id?: number;
  product_id?: number;
  serial_number?: string;
  manufacturer?: string;
}

interface SerialLine {
  time: string;
  data: string;
  direction: "rx" | "tx";
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function nowTime(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

export function SerialPanel() {
  const { t } = useI18n();
  const [portName, setPortName] = useState("COM3");
  const [baudRate, setBaudRate] = useState(115200);
  const [dataBits, setDataBits] = useState(8);
  const [stopBits, setStopBits] = useState(1);
  const [parity, setParity] = useState("None");
  const [flowControl, setFlowControl] = useState("None");
  const [encoding, setEncoding] = useState<Encoding>("UTF-8");

  const [status, setStatus] = useState<SerialStatus>("disconnected");
  const [sendValue, setSendValue] = useState("");
  const [showTimestamp, setShowTimestamp] = useState(true);
  const [showHex, setShowHex] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [periodicEnabled, setPeriodicEnabled] = useState(false);
  const [periodicInterval, setPeriodicInterval] = useState("1000");
  const [periodicCmd, setPeriodicCmd] = useState("");

  const [rxLines, setRxLines] = useState<SerialLine[]>([]);
  const [txLines, setTxLines] = useState<SerialLine[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleScanPorts = useCallback(async () => {
    try {
      const result = await invoke<PortInfo[]>("serial_scan_ports");
      setPorts(result);
    } catch (e) {
      console.error("Port scan failed:", e);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (status === "connected") {
      // Disconnect
      if (periodicTimerRef.current) {
        clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
      if (sessionIdRef.current) {
        try {
          await invoke("serial_close", { id: sessionIdRef.current });
        } catch { /* ignore */ }
        sessionIdRef.current = null;
      }
      setStatus("disconnected");
      return;
    }

    setStatus("connecting");
    try {
      const onData = new Channel<number[]>();
      onData.onmessage = (data: number[]) => {
        const text = new TextDecoder().decode(new Uint8Array(data));
        setRxLines((prev) => [...prev, { time: nowTime(), data: text, direction: "rx" }]);
      };

      const config: SerialConfig = {
        portName,
        baudRate,
        dataBits,
        stopBits,
        parity,
        flowControl,
      };

      const id = await invoke<string>("serial_open", { config, onData });
      sessionIdRef.current = id;
      setStatus("connected");
    } catch (e) {
      console.error("Serial open failed:", e);
      setStatus("disconnected");
    }
  }, [status, portName, baudRate, dataBits, stopBits, parity, flowControl]);

  const handleSend = useCallback(async () => {
    if (!sendValue.trim() || !sessionIdRef.current) return;
    try {
      const data = new TextEncoder().encode(sendValue);
      await invoke("serial_write", { id: sessionIdRef.current, data: Array.from(data) });
      setTxLines((prev) => [...prev, { time: nowTime(), data: sendValue, direction: "tx" }]);
      setSendValue("");
    } catch (e) {
      console.error("Serial write failed:", e);
    }
  }, [sendValue]);

  const handleQuickCmd = useCallback(
    async (cmd: string) => {
      if (!sessionIdRef.current) return;
      try {
        const data = new TextEncoder().encode(cmd + "\r\n");
        await invoke("serial_write", { id: sessionIdRef.current, data: Array.from(data) });
        setTxLines((prev) => [...prev, { time: nowTime(), data: cmd, direction: "tx" }]);
      } catch (e) {
        console.error("Quick cmd failed:", e);
      }
    },
    []
  );

  const togglePeriodic = useCallback(() => {
    if (periodicEnabled) {
      if (periodicTimerRef.current) {
        clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
      setPeriodicEnabled(false);
    } else {
      const interval = parseInt(periodicInterval, 10) || 1000;
      periodicTimerRef.current = setInterval(() => {
        if (sessionIdRef.current && periodicCmd) {
          const data = new TextEncoder().encode(periodicCmd + "\r\n");
          invoke("serial_write", { id: sessionIdRef.current, data: Array.from(data) }).catch(
            () => {}
          );
        }
      }, interval);
      setPeriodicEnabled(true);
    }
  }, [periodicEnabled, periodicInterval, periodicCmd]);

  const configSummary =
    status === "connected" ? `${portName} · ${baudRate} ${dataBits}${parity[0]}${stopBits}` : "";

  return (
    <div className="serial-panel-container">
      {/* Config grid */}
      <div className="serial-config">
        <div className="serial-field">
          <label>{t("protocol.serial.port")}</label>
          <Select
            value={portName}
            onChange={setPortName}
            disabled={status === "connected"}
            searchable={ports.length >= 8}
            options={
              ports.length > 0
                ? ports.map((p) => ({
                    value: p.port_name,
                    label: `${p.port_name}${p.manufacturer ? ` — ${p.manufacturer}` : ""}`,
                  }))
                : ["COM3", "COM5", "/dev/ttyUSB0"]
            }
          />
        </div>
        <div className="serial-field">
          <label>{t("protocol.serial.baudRate")}</label>
          <Select
            value={String(baudRate)}
            onChange={(v) => setBaudRate(Number(v))}
            disabled={status === "connected"}
            searchable={false}
            options={BAUD_RATES.map((r) => String(r))}
          />
        </div>
        <div className="serial-field">
          <label>{t("protocol.serial.dataBits")}</label>
          <Select
            value={String(dataBits)}
            onChange={(v) => setDataBits(Number(v))}
            disabled={status === "connected"}
            searchable={false}
            options={["7", "8"]}
          />
        </div>
        <div className="serial-field">
          <label>{t("protocol.serial.stopBits")}</label>
          <Select
            value={String(stopBits)}
            onChange={(v) => setStopBits(Number(v))}
            disabled={status === "connected"}
            searchable={false}
            options={["1", "2"]}
          />
        </div>
        <div className="serial-field">
          <label>{t("protocol.serial.parity")}</label>
          <Select
            value={parity}
            onChange={setParity}
            disabled={status === "connected"}
            searchable={false}
            options={["None", "Even", "Odd"]}
          />
        </div>
        <div className="serial-field">
          <label>{t("protocol.serial.flowControl")}</label>
          <Select
            value={flowControl}
            onChange={setFlowControl}
            disabled={status === "connected"}
            searchable={false}
            options={["None", "RTS/CTS", "XON/XOFF"]}
          />
        </div>
        <div className="serial-field">
          <label>{t("protocol.serial.encoding")}</label>
          <Select
            value={encoding}
            onChange={(v) => setEncoding(v as Encoding)}
            searchable={false}
            options={["UTF-8", "ASCII", "HEX"]}
          />
        </div>
        <div className="serial-field">
          <label>{" "}</label>
          <div style={{ display: "flex", gap: "var(--sp-1)" }}>
            <Button
              variant={status === "connected" ? "danger" : "primary"}
              style={{ flex: 1 }}
              onClick={handleConnect}
            >
              {status === "connected"
                ? t("protocol.common.disconnect")
                : status === "connecting"
                  ? "…"
                  : t("protocol.common.connect")}
            </Button>
            <Button variant="ghost" onClick={handleScanPorts} title={t("protocol.serial.scanPorts")}>
              &#x21bb;
            </Button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          marginBottom: "var(--sp-3)",
          fontSize: "11px",
        }}
      >
        <span className={`badge ${status === "connected" ? "badge-success" : "badge-muted"}`}>
          {status === "connecting"
            ? t("protocol.common.connecting")
            : status === "connected"
              ? t("protocol.common.connected")
              : t("protocol.common.disconnected")}
        </span>
        {status === "connected" && (
          <>
            <span className="text-muted">{configSummary}</span>
            <span className="text-muted">
              {t("protocol.serial.rxTx", { rx: rxLines.length, tx: txLines.length })}
            </span>
          </>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: "var(--sp-2)" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showTimestamp}
              onChange={(e) => setShowTimestamp(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />{" "}
            {t("protocol.serial.showTimestamp")}
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showHex}
              onChange={(e) => setShowHex(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />{" "}
            {t("protocol.serial.showHex")}
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />{" "}
            {t("protocol.serial.autoScroll")}
          </label>
        </div>
      </div>

      {/* Serial I/O */}
      <div className="serial-io">
        <div className="serial-panel">
          <div className="serial-panel-header">{t("protocol.serial.received")}</div>
          <div className="serial-panel-body">
            {rxLines.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                {t("protocol.serial.noRxData")}
              </div>
            ) : (
              rxLines.map((line, i) => (
                <div key={i}>
                  {showTimestamp ? `[${line.time}] ` : ""}
                  {line.data}
                </div>
              ))
            )}
          </div>
          <div className="serial-panel-input">
            <input
              placeholder={t("protocol.serial.sendPlaceholder")}
              value={sendValue}
              onChange={(e) => setSendValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              disabled={status !== "connected"}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleSend}
              disabled={status !== "connected"}
            >
              {t("protocol.common.send")}
            </Button>
          </div>
        </div>
        <div className="serial-panel">
          <div className="serial-panel-header">{t("protocol.serial.sent")}</div>
          <div className="serial-panel-body">
            {txLines.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{t("protocol.serial.noTxData")}</div>
            ) : (
              txLines.map((line, i) => (
                <div key={i}>
                  {showTimestamp ? `[${line.time}] ` : ""}
                  {line.data}
                </div>
              ))
            )}
          </div>
          <div className="serial-panel-input">
            <div style={{ display: "flex", gap: "var(--sp-1)", flexWrap: "wrap" }}>
              {["AT", "AT+RST", "AT+GMR", "AT+CWLAP"].map((cmd) => (
                <Button
                  key={cmd}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleQuickCmd(cmd)}
                  disabled={status !== "connected"}
                >
                  {cmd}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Periodic send */}
      <div
        style={{
          marginTop: "var(--sp-3)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          fontSize: "11px",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <input
            type="checkbox"
            checked={periodicEnabled}
            onChange={togglePeriodic}
            style={{ accentColor: "var(--accent)" }}
          />{" "}
          {t("protocol.serial.periodicSend")}
        </label>
        <input
          className="input"
          placeholder={t("protocol.serial.intervalMs")}
          value={periodicInterval}
          onChange={(e) => setPeriodicInterval(e.target.value)}
          style={{ width: "80px", fontSize: "11px" }}
        />
        <input
          className="input"
          placeholder={t("protocol.serial.periodicPayload")}
          value={periodicCmd}
          onChange={(e) => setPeriodicCmd(e.target.value)}
          style={{ flex: 1, fontSize: "11px" }}
        />
        <Button variant="ghost" size="sm" onClick={togglePeriodic}>
          {periodicEnabled ? t("protocol.serial.stop") : t("protocol.serial.start")}
        </Button>
      </div>
    </div>
  );
}

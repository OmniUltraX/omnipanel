import { useState, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

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
          <label>Port</label>
          <select
            value={portName}
            onChange={(e) => setPortName(e.target.value)}
            disabled={status === "connected"}
          >
            {ports.length > 0 ? (
              ports.map((p) => (
                <option key={p.port_name} value={p.port_name}>
                  {p.port_name} {p.manufacturer ? `— ${p.manufacturer}` : ""}
                </option>
              ))
            ) : (
              <>
                <option>COM3</option>
                <option>COM5</option>
                <option>/dev/ttyUSB0</option>
              </>
            )}
          </select>
        </div>
        <div className="serial-field">
          <label>Baud Rate</label>
          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={status === "connected"}
          >
            {BAUD_RATES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="serial-field">
          <label>Data Bits</label>
          <select
            value={dataBits}
            onChange={(e) => setDataBits(Number(e.target.value))}
            disabled={status === "connected"}
          >
            <option value={7}>7</option>
            <option value={8}>8</option>
          </select>
        </div>
        <div className="serial-field">
          <label>Stop Bits</label>
          <select
            value={stopBits}
            onChange={(e) => setStopBits(Number(e.target.value))}
            disabled={status === "connected"}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </div>
        <div className="serial-field">
          <label>Parity</label>
          <select
            value={parity}
            onChange={(e) => setParity(e.target.value)}
            disabled={status === "connected"}
          >
            <option>None</option>
            <option>Even</option>
            <option>Odd</option>
          </select>
        </div>
        <div className="serial-field">
          <label>Flow Control</label>
          <select
            value={flowControl}
            onChange={(e) => setFlowControl(e.target.value)}
            disabled={status === "connected"}
          >
            <option>None</option>
            <option>RTS/CTS</option>
            <option>XON/XOFF</option>
          </select>
        </div>
        <div className="serial-field">
          <label>Encoding</label>
          <select value={encoding} onChange={(e) => setEncoding(e.target.value as Encoding)}>
            <option>UTF-8</option>
            <option>ASCII</option>
            <option>HEX</option>
          </select>
        </div>
        <div className="serial-field">
          <label>{" "}</label>
          <div style={{ display: "flex", gap: "var(--sp-1)" }}>
            <button
              className={`btn ${status === "connected" ? "btn-danger" : "btn-primary"}`}
              style={{ flex: 1 }}
              onClick={handleConnect}
            >
              {status === "connected" ? "Disconnect" : status === "connecting" ? "..." : "Connect"}
            </button>
            <button className="btn btn-ghost" onClick={handleScanPorts} title="Scan ports">
              &#x21bb;
            </button>
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
            ? "Connecting..."
            : status === "connected"
              ? "Connected"
              : "Disconnected"}
        </span>
        {status === "connected" && (
          <>
            <span className="text-muted">{configSummary}</span>
            <span className="text-muted">
              RX: {rxLines.length} · TX: {txLines.length}
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
            Timestamp
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
            HEX
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
            Auto-scroll
          </label>
        </div>
      </div>

      {/* Serial I/O */}
      <div className="serial-io">
        <div className="serial-panel">
          <div className="serial-panel-header">Received</div>
          <div className="serial-panel-body">
            {rxLines.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                No data received
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
              placeholder="Send data..."
              value={sendValue}
              onChange={(e) => setSendValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              disabled={status !== "connected"}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSend}
              disabled={status !== "connected"}
            >
              Send
            </button>
          </div>
        </div>
        <div className="serial-panel">
          <div className="serial-panel-header">Sent</div>
          <div className="serial-panel-body">
            {txLines.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No data sent</div>
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
                <button
                  key={cmd}
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleQuickCmd(cmd)}
                  disabled={status !== "connected"}
                >
                  {cmd}
                </button>
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
          Periodic Send
        </label>
        <input
          className="input"
          placeholder="Interval (ms)"
          value={periodicInterval}
          onChange={(e) => setPeriodicInterval(e.target.value)}
          style={{ width: "80px", fontSize: "11px" }}
        />
        <input
          className="input"
          placeholder='{"cmd":"read_sensor"}'
          value={periodicCmd}
          onChange={(e) => setPeriodicCmd(e.target.value)}
          style={{ flex: 1, fontSize: "11px" }}
        />
        <button className="btn btn-ghost btn-sm" onClick={togglePeriodic}>
          {periodicEnabled ? "Stop" : "Start"}
        </button>
      </div>
    </div>
  );
}

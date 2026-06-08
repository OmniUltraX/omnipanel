import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { Select } from "../../components/ui/Select";

type RegisterType = "coils" | "discrete_inputs" | "holding_registers" | "input_registers";

const STYLE = {
  panel: { display: "flex", flexDirection: "column" as const, height: "100%", padding: 16, gap: 16, background: "var(--bg, #1a1a2e)" },
  section: { background: "var(--bg-secondary, #16162a)", borderRadius: 8, padding: 16, border: "1px solid var(--border, #333)" },
  row: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
  label: { fontSize: 12, color: "var(--text-dim, #888)", minWidth: 80 },
  input: { flex: 1, padding: "6px 10px", background: "var(--bg, #1a1a2e)", border: "1px solid var(--border, #444)", color: "var(--text, #e0e0e0)", borderRadius: 4, fontSize: 13 },
  btn: (accent = false) => ({
    padding: "6px 16px", background: accent ? "var(--accent, #7c5cfc)" : "var(--bg-tertiary, #222)",
    border: "1px solid var(--border, #444)", color: "var(--text, #e0e0e0)", borderRadius: 4,
    cursor: "pointer", fontSize: 13,
  }),
  status: (connected: boolean) => ({
    padding: "4px 12px", borderRadius: 12, fontSize: 12, fontWeight: 600,
    background: connected ? "rgba(76,175,80,0.2)" : "rgba(244,67,54,0.2)",
    color: connected ? "#4caf50" : "#f44336",
  }),
  resultBox: { background: "var(--bg, #1a1a2e)", border: "1px solid var(--border, #444)", borderRadius: 4, padding: 12, fontFamily: "monospace", fontSize: 13, minHeight: 60, color: "var(--text, #e0e0e0)", whiteSpace: "pre-wrap" as const },
  title: { fontSize: 14, fontWeight: 600, color: "var(--text, #e0e0e0)", marginBottom: 12 },
};

export function ModbusPanel() {
  const { t } = useI18n();
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("502");
  const [slaveId, setSlaveId] = useState("1");
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [regType, setRegType] = useState<RegisterType>("holding_registers");
  const [readAddr, setReadAddr] = useState("0");
  const [readQty, setReadQty] = useState("10");
  const [writeAddr, setWriteAddr] = useState("0");
  const [writeValue, setWriteValue] = useState("0");
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const handleConnect = useCallback(async () => {
    try {
      setBusy(true);
      const id = await invoke<string>("modbus_connect", {
        config: { host, port: parseInt(port), slave_id: parseInt(slaveId), mode: "tcp" },
      });
      setSessionId(id);
      setConnected(true);
      setResult(`Connected: ${id}`);
    } catch (e) {
      setResult(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [host, port, slaveId]);

  const handleDisconnect = useCallback(async () => {
    if (!sessionId) return;
    try {
      await invoke("modbus_disconnect", { id: sessionId });
      setConnected(false);
      setSessionId(null);
      setResult("Disconnected");
    } catch (e) {
      setResult(`Error: ${e}`);
    }
  }, [sessionId]);

  const handleRead = useCallback(async () => {
    if (!sessionId) return;
    try {
      setBusy(true);
      const addr = parseInt(readAddr);
      const qty = parseInt(readQty);
      let data: any;
      switch (regType) {
        case "coils":
          data = await invoke<boolean[]>("modbus_read_coils", { id: sessionId, addr, qty });
          break;
        case "discrete_inputs":
          data = await invoke<boolean[]>("modbus_read_discrete_inputs", { id: sessionId, addr, qty });
          break;
        case "holding_registers":
          data = await invoke<number[]>("modbus_read_holding_registers", { id: sessionId, addr, qty });
          break;
        case "input_registers":
          data = await invoke<number[]>("modbus_read_input_registers", { id: sessionId, addr, qty });
          break;
      }
      const formatted = Array.isArray(data)
        ? data.map((v: any, i: number) => `[${addr + i}] = ${v}`).join("\n")
        : JSON.stringify(data);
      setResult(`Read ${regType} (addr=${addr}, qty=${qty}):\n${formatted}`);
    } catch (e) {
      setResult(`Read error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [sessionId, regType, readAddr, readQty]);

  const handleWrite = useCallback(async () => {
    if (!sessionId) return;
    try {
      setBusy(true);
      const addr = parseInt(writeAddr);
      const val = writeValue;
      if (regType === "coils") {
        await invoke("modbus_write_single_coil", { id: sessionId, addr, value: val === "true" || val === "1" });
      } else {
        await invoke("modbus_write_single_register", { id: sessionId, addr, value: parseInt(val) });
      }
      setResult(`Write ${regType}[${addr}] = ${val} — OK`);
    } catch (e) {
      setResult(`Write error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [sessionId, regType, writeAddr, writeValue]);

  return (
    <div style={STYLE.panel}>
      {/* Connection */}
      <div style={STYLE.section}>
        <div style={STYLE.title}>🔌 Modbus Connection</div>
        <div style={STYLE.row}>
          <span style={STYLE.label}>Host</span>
          <input style={STYLE.input} value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" disabled={connected} />
          <span style={STYLE.label}>Port</span>
          <input style={{ ...STYLE.input, maxWidth: 80 }} value={port} onChange={(e) => setPort(e.target.value)} placeholder="502" disabled={connected} />
          <span style={STYLE.label}>Slave ID</span>
          <input style={{ ...STYLE.input, maxWidth: 60 }} value={slaveId} onChange={(e) => setSlaveId(e.target.value)} placeholder="1" disabled={connected} />
        </div>
        <div style={STYLE.row}>
          <span style={STYLE.status(connected)}>{connected ? "● Connected" : "○ Disconnected"}</span>
          <div style={{ flex: 1 }} />
          {connected ? (
            <button style={STYLE.btn()} onClick={handleDisconnect}>Disconnect</button>
          ) : (
            <button style={STYLE.btn(true)} onClick={handleConnect} disabled={busy}>Connect</button>
          )}
        </div>
      </div>

      {/* Read/Write */}
      <div style={{ display: "flex", gap: 16, flex: 1 }}>
        {/* Read */}
        <div style={{ ...STYLE.section, flex: 1 }}>
          <div style={STYLE.title}>📖 Read Registers</div>
          <div style={STYLE.row}>
            <span style={STYLE.label}>Type</span>
            <Select
              size="sm"
              value={regType}
              onChange={(v) => setRegType(v as RegisterType)}
              searchable={false}
              options={[
                { value: "coils", label: "Coils (0x)" },
                { value: "discrete_inputs", label: "Discrete Inputs (1x)" },
                { value: "holding_registers", label: "Holding Registers (4x)" },
                { value: "input_registers", label: "Input Registers (3x)" },
              ]}
            />
          </div>
          <div style={STYLE.row}>
            <span style={STYLE.label}>Address</span>
            <input style={STYLE.input} value={readAddr} onChange={(e) => setReadAddr(e.target.value)} />
            <span style={STYLE.label}>Quantity</span>
            <input style={{ ...STYLE.input, maxWidth: 80 }} value={readQty} onChange={(e) => setReadQty(e.target.value)} />
          </div>
          <button style={STYLE.btn(true)} onClick={handleRead} disabled={!connected || busy}>Read</button>
        </div>

        {/* Write */}
        <div style={{ ...STYLE.section, flex: 1 }}>
          <div style={STYLE.title}>✏️ Write Register</div>
          <div style={STYLE.row}>
            <span style={STYLE.label}>Type</span>
            <Select
              size="sm"
              value={regType}
              onChange={(v) => setRegType(v as RegisterType)}
              searchable={false}
              options={[
                { value: "coils", label: "Coils (0x)" },
                { value: "holding_registers", label: "Holding Registers (4x)" },
              ]}
            />
          </div>
          <div style={STYLE.row}>
            <span style={STYLE.label}>Address</span>
            <input style={STYLE.input} value={writeAddr} onChange={(e) => setWriteAddr(e.target.value)} />
            <span style={STYLE.label}>Value</span>
            <input style={STYLE.input} value={writeValue} onChange={(e) => setWriteValue(e.target.value)} />
          </div>
          <button style={STYLE.btn(true)} onClick={handleWrite} disabled={!connected || busy}>Write</button>
        </div>
      </div>

      {/* Result */}
      <div style={STYLE.section}>
        <div style={STYLE.title}>📋 Result</div>
        <div style={STYLE.resultBox}>{result || "No data yet..."}</div>
      </div>
    </div>
  );
}

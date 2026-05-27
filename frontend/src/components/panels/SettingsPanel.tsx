import { useState, useCallback } from "react";
import { useAiStore } from "../../stores/aiStore";

type Section = "general" | "appearance" | "keybindings" | "ai" | "security" | "terminal" | "data";

interface NavItem {
  id: Section;
  label: string;
  icon: JSX.Element;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "general",
    label: "General",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8" />
      </svg>
    ),
  },
  {
    id: "ai",
    label: "AI Models",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
        <path d="M12 17v4M8 21h8" />
      </svg>
    ),
  },
  {
    id: "security",
    label: "Security",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "Data & Backup",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
    ),
  },
];

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={`toggle ${value ? "on" : ""}`}
      onClick={() => onChange(!value)}
      style={{ cursor: "pointer" }}
    />
  );
}

function SettingSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select className="setting-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

export function SettingsPanel() {
  const [activeSection, setActiveSection] = useState<Section>("general");

  // General settings state
  const [language, setLanguage] = useState("中文");
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [restoreSession, setRestoreSession] = useState(true);
  const [checkUpdates, setCheckUpdates] = useState(true);
  const [telemetry, setTelemetry] = useState(false);

  // Appearance settings state
  const [theme, setTheme] = useState("Dark (Default)");
  const [uiDensity, setUiDensity] = useState("Standard");
  const [sidebarPos, setSidebarPos] = useState("Left");

  // AI settings — connected to aiStore
  const currentProvider = useAiStore((s) => s.currentProvider);
  const currentModel = useAiStore((s) => s.currentModel);
  const setCurrentProvider = useAiStore((s) => s.setCurrentProvider);
  const [streamResponses, setStreamResponses] = useState(true);
  const [preferLocal, setPreferLocal] = useState(true);

  // Security settings state
  const [credentialStorage, setCredentialStorage] = useState("System Keychain");
  const [prodConfirm, setProdConfirm] = useState(true);
  const [dangerDetection, setDangerDetection] = useState(true);
  const [aiApproval, setAiApproval] = useState(true);
  const [dataSentToAi, setDataSentToAi] = useState("Minimal (sanitized)");
  const [auditLog, setAuditLog] = useState(true);
  const [sensitiveMask, setSensitiveMask] = useState(true);

  // Terminal settings state
  const [fontFamily, setFontFamily] = useState("Berkeley Mono");
  const [fontSize, setFontSize] = useState("13px");
  const [lineHeight, setLineHeight] = useState("1.6");
  const [cursorStyle, setCursorStyle] = useState("Bar");
  const [cursorBlink, setCursorBlink] = useState(true);
  const [scrollback, setScrollback] = useState("10000");
  const [gpuAccel, setGpuAccel] = useState(true);
  const [copyOnSelect, setCopyOnSelect] = useState(false);

  return (
    <div className="settings-workspace">
      <div className="settings-nav">
        {NAV_ITEMS.map((item) => (
          <div
            key={item.id}
            className={`settings-nav-item ${activeSection === item.id ? "active" : ""}`}
            onClick={() => setActiveSection(item.id)}
          >
            {item.icon}
            {item.label}
          </div>
        ))}
      </div>

      <div className="settings-main">
        {/* General */}
        {activeSection === "general" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>General</h2>
              <p className="section-desc">Application behavior and startup settings</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Language</h4>
                  <p>Interface display language</p>
                </div>
                <SettingSelect value={language} onChange={setLanguage} options={["English", "中文", "日本語"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Launch on startup</h4>
                  <p>Start OmniPanel when your computer starts</p>
                </div>
                <Toggle value={launchOnStartup} onChange={setLaunchOnStartup} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Restore last session</h4>
                  <p>Reopen tabs, layouts and connections from last session</p>
                </div>
                <Toggle value={restoreSession} onChange={setRestoreSession} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Check for updates</h4>
                  <p>Automatically check for new versions</p>
                </div>
                <Toggle value={checkUpdates} onChange={setCheckUpdates} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Telemetry</h4>
                  <p>Send anonymous usage data (no personal data collected)</p>
                </div>
                <Toggle value={telemetry} onChange={setTelemetry} />
              </div>
            </div>
          </div>
        )}

        {/* Appearance */}
        {activeSection === "appearance" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>Appearance</h2>
              <p className="section-desc">Theme, font, and density settings</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Theme</h4>
                  <p>Application color scheme</p>
                </div>
                <SettingSelect value={theme} onChange={setTheme} options={["Dark (Default)", "Light", "System"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Accent Color</h4>
                  <p>Primary accent color for highlights and actions</p>
                </div>
                <div style={{ display: "flex", gap: "var(--sp-2)" }}>
                  {["var(--accent)", "#30d158", "#ff9f0a", "#ff3b30", "#bf5af2"].map((color) => (
                    <div
                      key={color}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        background: color,
                        cursor: "pointer",
                        border: `2px solid ${color === "var(--accent)" ? "var(--fg)" : "transparent"}`,
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>UI Density</h4>
                  <p>Controls spacing and element size</p>
                </div>
                <SettingSelect value={uiDensity} onChange={setUiDensity} options={["Compact", "Standard", "Comfortable"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Sidebar position</h4>
                  <p>Left or right side of the window</p>
                </div>
                <SettingSelect value={sidebarPos} onChange={setSidebarPos} options={["Left", "Right"]} />
              </div>
            </div>
          </div>
        )}

        {/* Keybindings */}
        {activeSection === "keybindings" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>Keybindings</h2>
              <p className="section-desc">Keyboard shortcuts for all major actions</p>
              {[
                ["New Terminal Tab", "Ctrl", "T"],
                ["Close Tab", "Ctrl", "W"],
                ["Switch Tab", "Ctrl", "Tab"],
                ["Command Palette", "Ctrl", "K"],
                ["Toggle AI Panel", "Ctrl", "L"],
                ["Vertical Split", "Ctrl", "\\"],
                ["Horizontal Split", "Ctrl", "Shift", "\\"],
                ["Search in Terminal", "Ctrl", "F"],
                ["New SSH Connection", "Ctrl", "N"],
                ["Settings", "Ctrl", ","],
                ["Toggle Tab N", "Ctrl", "1-9"],
              ].map(([label, ...keys]) => (
                <div key={label} className="setting-row">
                  <div className="setting-label">
                    <h4>{label}</h4>
                  </div>
                  <div className="keybind">
                    {keys.map((k, i) => (
                      <span key={i}>
                        {i > 0 && " + "}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Models */}
        {activeSection === "ai" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>AI Models</h2>
              <p className="section-desc">Configure AI providers and model preferences</p>

              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: "var(--sp-3)" }}>
                Cloud API Providers
              </h3>
              {[
                { id: "anthropic", icon: "C", name: "Claude API", desc: "Anthropic Claude · claude-sonnet-4-6", color: "var(--accent-soft)", textColor: "var(--accent)", provider: "anthropic", model: "claude-sonnet-4-6" },
                { id: "openai", icon: "G", name: "OpenAI API", desc: "GPT-4o · gpt-4o-2024-08-06", color: "var(--success-soft)", textColor: "var(--success)", provider: "openai", model: "gpt-4o" },
                { id: "deepseek", icon: "D", name: "DeepSeek API", desc: "DeepSeek Coder · deepseek-coder-v2", color: "var(--warn-soft)", textColor: "var(--warn)", provider: "deepseek", model: "deepseek-coder-v2" },
              ].map((p) => (
                <div key={p.id} className="provider-card">
                  <div className="provider-icon" style={{ background: p.color, color: p.textColor }}>
                    {p.icon}
                  </div>
                  <div className="provider-info">
                    <div className="provider-name">{p.name}</div>
                    <div className="provider-desc">{p.desc}</div>
                  </div>
                  <span className={`badge ${currentProvider === p.provider ? "badge-success" : "badge-muted"}`}>
                    {currentProvider === p.provider ? "Active" : "Inactive"}
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setCurrentProvider(p.provider, p.model)}
                  >
                    {currentProvider === p.provider ? "Selected" : "Select"}
                  </button>
                </div>
              ))}

              <h3 style={{ fontSize: 13, fontWeight: 600, margin: "var(--sp-4) 0 var(--sp-3)" }}>
                Local Models
              </h3>
              <div className="provider-card">
                <div className="provider-icon" style={{ background: "var(--surface)", color: "var(--fg-2)" }}>O</div>
                <div className="provider-info">
                  <div className="provider-name">Ollama</div>
                  <div className="provider-desc">localhost:11434 · codellama:34b</div>
                </div>
                <span className="badge badge-success">Connected</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCurrentProvider("ollama", "codellama:34b")}
                >
                  {currentProvider === "ollama" ? "Selected" : "Select"}
                </button>
              </div>

              <div className="setting-row" style={{ marginTop: "var(--sp-4)" }}>
                <div className="setting-label">
                  <h4>Stream responses</h4>
                  <p>Show AI responses as they are generated</p>
                </div>
                <Toggle value={streamResponses} onChange={setStreamResponses} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Prefer local models for sensitive data</h4>
                  <p>Automatically use local models when connected to production</p>
                </div>
                <Toggle value={preferLocal} onChange={setPreferLocal} />
              </div>
            </div>
          </div>
        )}

        {/* Security */}
        {activeSection === "security" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>Security</h2>
              <p className="section-desc">Credential storage, AI safety, and operation policies</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Credential Storage</h4>
                  <p>Where SSH keys, DB passwords, and API keys are stored</p>
                </div>
                <SettingSelect value={credentialStorage} onChange={setCredentialStorage} options={["System Keychain", "Encrypted SQLite"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Production environment confirmation</h4>
                  <p>Require confirmation before executing commands on prod servers</p>
                </div>
                <Toggle value={prodConfirm} onChange={setProdConfirm} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Dangerous command detection</h4>
                  <p>Warn before executing rm -rf, DROP TABLE, docker rm, etc.</p>
                </div>
                <Toggle value={dangerDetection} onChange={setDangerDetection} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>AI operation approval</h4>
                  <p>Require user confirmation before AI executes any write operation</p>
                </div>
                <Toggle value={aiApproval} onChange={setAiApproval} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Data sent to AI</h4>
                  <p>What context is included when sending to AI providers</p>
                </div>
                <SettingSelect value={dataSentToAi} onChange={setDataSentToAi} options={["Minimal (sanitized)", "Full context", "None"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Audit logging</h4>
                  <p>Record all high-risk operations, AI actions, and data modifications</p>
                </div>
                <Toggle value={auditLog} onChange={setAuditLog} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Sensitive data masking</h4>
                  <p>Automatically mask emails, phones, tokens, and passwords in display</p>
                </div>
                <Toggle value={sensitiveMask} onChange={setSensitiveMask} />
              </div>
            </div>
          </div>
        )}

        {/* Terminal */}
        {activeSection === "terminal" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>Terminal</h2>
              <p className="section-desc">Terminal emulator settings</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Font Family</h4>
                  <p>Monospace font for terminal</p>
                </div>
                <SettingSelect value={fontFamily} onChange={setFontFamily} options={["Berkeley Mono", "JetBrains Mono", "Fira Code", "IBM Plex Mono", "Cascadia Code"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Font Size</h4>
                </div>
                <SettingSelect value={fontSize} onChange={setFontSize} options={["11px", "12px", "13px", "14px", "15px", "16px", "18px"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Line Height</h4>
                </div>
                <SettingSelect value={lineHeight} onChange={setLineHeight} options={["1.2", "1.4", "1.6", "1.8"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Cursor Style</h4>
                </div>
                <SettingSelect value={cursorStyle} onChange={setCursorStyle} options={["Block", "Bar", "Underline"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Cursor Blink</h4>
                </div>
                <Toggle value={cursorBlink} onChange={setCursorBlink} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Scrollback Lines</h4>
                  <p>Number of lines to keep in scroll buffer</p>
                </div>
                <SettingSelect value={scrollback} onChange={setScrollback} options={["1000", "5000", "10000", "50000"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>GPU Acceleration</h4>
                  <p>Use WebGL for terminal rendering</p>
                </div>
                <Toggle value={gpuAccel} onChange={setGpuAccel} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Copy on select</h4>
                  <p>Automatically copy selected text to clipboard</p>
                </div>
                <Toggle value={copyOnSelect} onChange={setCopyOnSelect} />
              </div>
            </div>
          </div>
        )}

        {/* Data & Backup */}
        {activeSection === "data" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>Data &amp; Backup</h2>
              <p className="section-desc">Local data management, import/export, and cleanup</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Export all data</h4>
                  <p>Export connections, settings, history, and workflows to a file</p>
                </div>
                <button className="btn btn-secondary btn-sm">Export</button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Import data</h4>
                  <p>Import from OmniPanel export, Xshell, WindTerm, or OpenSSH config</p>
                </div>
                <button className="btn btn-secondary btn-sm">Import</button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Clear command history</h4>
                  <p>Remove all saved terminal command history</p>
                </div>
                <button className="btn btn-danger btn-sm">Clear</button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Clear AI conversation history</h4>
                  <p>Remove all saved AI chat history</p>
                </div>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    useAiStore.setState({ conversations: [], activeConversationId: null });
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Clear SQL history</h4>
                  <p>Remove all saved SQL query history</p>
                </div>
                <button className="btn btn-danger btn-sm">Clear</button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Reset all settings</h4>
                  <p>Restore all settings to factory defaults</p>
                </div>
                <button className="btn btn-danger btn-sm">Reset</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAiStore } from "../../stores/aiStore";
import { useThemeStore } from "../../store/theme";
import { useSettingsStore, LOCALE_OPTIONS, type Locale } from "../../stores/settingsStore";
import { useI18n } from "../../i18n";

type Section = "general" | "appearance" | "keybindings" | "ai" | "security" | "terminal" | "data";

interface NavItem {
  id: Section;
  label: string;
  icon: ReactNode;
}

interface UpdateInfo {
  available: boolean;
  version: string;
  body: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "general",
    label: "通用",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "外观",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
  {
    id: "keybindings",
    label: "快捷键",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8" />
      </svg>
    ),
  },
  {
    id: "ai",
    label: "AI 模型",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
        <path d="M12 17v4M8 21h8" />
      </svg>
    ),
  },
  {
    id: "security",
    label: "安全",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    id: "terminal",
    label: "终端",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "数据与备份",
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
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<Section>("general");

  const locale = useSettingsStore((s) => s.locale);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [restoreSession, setRestoreSession] = useState(true);
  const [checkUpdates, setCheckUpdates] = useState(true);
  const [telemetry, setTelemetry] = useState(false);

  // Appearance settings state
  const { theme, setTheme } = useThemeStore();
  const [uiDensity, setUiDensity] = useState("标准");
  const [sidebarPos, setSidebarPos] = useState("左侧");

  // AI settings — connected to aiStore
  const currentProvider = useAiStore((s) => s.currentProvider);
  const setCurrentProvider = useAiStore((s) => s.setCurrentProvider);
  const [streamResponses, setStreamResponses] = useState(true);
  const [preferLocal, setPreferLocal] = useState(true);

  // Security settings state
  const [credentialStorage, setCredentialStorage] = useState("系统钥匙串");
  const [prodConfirm, setProdConfirm] = useState(true);
  const [dangerDetection, setDangerDetection] = useState(true);
  const [aiApproval, setAiApproval] = useState(true);
  const [dataSentToAi, setDataSentToAi] = useState("最小化（已脱敏）");
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

  // Update state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await invoke<UpdateInfo>("check_update");
      setUpdateInfo(info);
    } catch (e) {
      console.error("Failed to check update:", e);
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    setUpdating(true);
    try {
      await invoke("install_update");
    } catch (e) {
      console.error("Failed to install update:", e);
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    if (checkUpdates) {
      checkUpdate();
    }
  }, [checkUpdates]);

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
              <h2>通用</h2>
              <p className="section-desc">应用行为、启动和会话恢复设置</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.language.label")}</h4>
                  <p>{t("settings.language.desc")}</p>
                </div>
                <select
                  className="setting-select"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as Locale)}
                >
                  {LOCALE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>开机启动</h4>
                  <p>系统启动后自动打开 OmniPanel</p>
                </div>
                <Toggle value={launchOnStartup} onChange={setLaunchOnStartup} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>恢复上次会话</h4>
                  <p>重新打开上次的标签、布局和连接</p>
                </div>
                <Toggle value={restoreSession} onChange={setRestoreSession} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>检查更新</h4>
                  <p>自动检查新版本</p>
                </div>
                <Toggle value={checkUpdates} onChange={setCheckUpdates} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>软件更新</h4>
                  <p>
                    当前版本：v0.1.0
                    {updateInfo?.available && (
                      <span style={{ color: "var(--accent)", marginLeft: "var(--sp-2)" }}>
                        发现新版本：v{updateInfo.version}
                      </span>
                    )}
                  </p>
                </div>
                <div style={{ display: "flex", gap: "var(--sp-2)" }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={checkUpdate}
                    disabled={checking}
                  >
                    {checking ? "检查中..." : "检查更新"}
                  </button>
                  {updateInfo?.available && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={installUpdate}
                      disabled={updating}
                    >
                      {updating ? "更新中..." : "立即更新"}
                    </button>
                  )}
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>遥测</h4>
                  <p>发送匿名使用数据，不收集个人信息</p>
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
              <h2>外观</h2>
              <p className="section-desc">主题、字体和界面密度设置</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>主题</h4>
                  <p>应用配色方案</p>
                </div>
                <select
                  className="setting-select"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as "system" | "light" | "dark")}
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>强调色</h4>
                  <p>用于高亮和主要操作的颜色</p>
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
                  <h4>界面密度</h4>
                  <p>控制间距和元素尺寸</p>
                </div>
                <SettingSelect value={uiDensity} onChange={setUiDensity} options={["紧凑", "标准", "舒适"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>侧栏位置</h4>
                  <p>显示在窗口左侧或右侧</p>
                </div>
                <SettingSelect value={sidebarPos} onChange={setSidebarPos} options={["左侧", "右侧"]} />
              </div>
            </div>
          </div>
        )}

        {/* Keybindings */}
        {activeSection === "keybindings" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>快捷键</h2>
              <p className="section-desc">主要操作的键盘快捷方式</p>
              {[
                ["新建终端标签", "Ctrl", "T"],
                ["关闭标签", "Ctrl", "W"],
                ["切换标签", "Ctrl", "Tab"],
                ["命令面板", "Ctrl", "K"],
                ["切换 AI 面板", "Ctrl", "L"],
                ["垂直分屏", "Ctrl", "\\"],
                ["水平分屏", "Ctrl", "Shift", "\\"],
                ["搜索终端", "Ctrl", "F"],
                ["新建 SSH 连接", "Ctrl", "N"],
                ["设置", "Ctrl", ","],
                ["切换到第 N 个标签", "Ctrl", "1-9"],
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
              <h2>AI 模型</h2>
              <p className="section-desc">配置 AI 提供商和模型偏好</p>

              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: "var(--sp-3)" }}>
                云端 API 提供商
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
                    {currentProvider === p.provider ? "使用中" : "未启用"}
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setCurrentProvider(p.provider, p.model)}
                  >
                    {currentProvider === p.provider ? "已选择" : "选择"}
                  </button>
                </div>
              ))}

              <h3 style={{ fontSize: 13, fontWeight: 600, margin: "var(--sp-4) 0 var(--sp-3)" }}>
                本地模型
              </h3>
              <div className="provider-card">
                <div className="provider-icon" style={{ background: "var(--surface)", color: "var(--fg-2)" }}>O</div>
                <div className="provider-info">
                  <div className="provider-name">Ollama</div>
                  <div className="provider-desc">localhost:11434 · codellama:34b</div>
                </div>
                <span className="badge badge-success">已连接</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCurrentProvider("ollama", "codellama:34b")}
                >
                  {currentProvider === "ollama" ? "已选择" : "选择"}
                </button>
              </div>

              <div className="setting-row" style={{ marginTop: "var(--sp-4)" }}>
                <div className="setting-label">
                  <h4>流式响应</h4>
                  <p>生成过程中实时显示 AI 回复</p>
                </div>
                <Toggle value={streamResponses} onChange={setStreamResponses} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>敏感数据优先本地模型</h4>
                  <p>连接生产环境时优先使用本地模型</p>
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
              <h2>安全</h2>
              <p className="section-desc">凭据存储、AI 安全和操作策略</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>凭据存储</h4>
                  <p>SSH Key、数据库密码和 API Key 的存储位置</p>
                </div>
                <SettingSelect value={credentialStorage} onChange={setCredentialStorage} options={["系统钥匙串", "加密 SQLite"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>生产环境确认</h4>
                  <p>在生产服务器执行操作前必须确认</p>
                </div>
                <Toggle value={prodConfirm} onChange={setProdConfirm} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>危险命令检测</h4>
                  <p>执行 rm -rf、DROP TABLE、docker rm 等操作前发出警告</p>
                </div>
                <Toggle value={dangerDetection} onChange={setDangerDetection} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>AI 操作审批</h4>
                  <p>AI 执行任何写操作前必须由用户确认</p>
                </div>
                <Toggle value={aiApproval} onChange={setAiApproval} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>发送给 AI 的数据</h4>
                  <p>发送给 AI 提供商时包含哪些上下文</p>
                </div>
                <SettingSelect value={dataSentToAi} onChange={setDataSentToAi} options={["最小化（已脱敏）", "完整上下文", "不发送"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>审计日志</h4>
                  <p>记录所有高风险操作、AI 动作和数据修改</p>
                </div>
                <Toggle value={auditLog} onChange={setAuditLog} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>敏感数据脱敏</h4>
                  <p>自动隐藏邮箱、手机号、Token 和密码</p>
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
              <h2>终端</h2>
              <p className="section-desc">终端模拟器设置</p>
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

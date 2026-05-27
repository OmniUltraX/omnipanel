import { useState, useCallback } from "react";

interface Props {
  code: string;
  language?: string;
  onRunInTerminal?: (command: string) => void;
}

const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "ps1",
  "fish",
  "cmd",
  "bat",
  "console",
  "terminal",
]);

export function isShellLanguage(lang?: string): boolean {
  if (!lang) return false;
  return SHELL_LANGUAGES.has(lang.toLowerCase());
}

export function CommandSuggestion({ code, language, onRunInTerminal }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const isShell = isShellLanguage(language);

  return (
    <div className="relative group my-2 rounded-md border border-border overflow-hidden">
      {/* Language badge + actions */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-border">
        <span className="text-[10px] text-meta font-mono">
          {language || "code"}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted hover:text-fg rounded transition-colors"
            title="Copy"
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          {isShell && onRunInTerminal && (
            <button
              onClick={() => onRunInTerminal(code)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent hover:text-accent/80 rounded transition-colors"
              title="Run in Terminal"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 17l6-6-6-6" />
                <path d="M12 19h8" />
              </svg>
              Run
            </button>
          )}
        </div>
      </div>

      {/* Code */}
      <pre className="px-3 py-2 text-sm font-mono text-fg-2 overflow-x-auto bg-bg-deeper">
        <code>{code}</code>
      </pre>
    </div>
  );
}

//! 将 Cursor ACP 内置工具映射为 OmniPanel 客户端工具（对齐 cursor-gateway translator/native_tools）。
//!
//! 支持的原生工具分类：
//! - Shell: 映射为 `omni_terminal_run_terminal_command`
//! - WebSearch: 映射为 `omni_web_search`
//! - WebFetch: 映射为 `omni_web_fetch`
//! - Read/Write/Edit/Find/Grep: 映射为 `omni_terminal_run_terminal_command`（用 cat/echo/sed/find/grep）

pub const TERMINAL_CLIENT_TOOL: &str = "omni_terminal_run_terminal_command";
pub const WEB_SEARCH_CLIENT_TOOL: &str = "omni_web_search";
pub const WEB_FETCH_CLIENT_TOOL: &str = "omni_web_fetch";

/// 原生工具分类，用于决定映射目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeToolKind {
    Shell,
    WebSearch,
    WebFetch,
    Read,
    Write,
    Edit,
    Find,
    Grep,
    Other,
}

/// 从 ACP `rawInput` 提取 shell 命令（支持 shellToolCall / command / script 等格式）。
pub fn extract_native_shell_command(raw: &serde_json::Value) -> Option<String> {
    if let Some(s) = raw.as_str() {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(obj) = raw.as_object() {
        if let Some(cmd) = obj
            .get("command")
            .or_else(|| obj.get("cmd"))
            .and_then(|v| v.as_str())
        {
            let trimmed = cmd.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(script) = obj.get("script").and_then(|v| v.as_str()) {
            let trimmed = script.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(args) = obj.get("args") {
            if let Some(cmd) = extract_native_shell_command(args) {
                return Some(cmd);
            }
        }
        for wrapper in ["shellToolCall", "shell_tool_call", "bashToolCall"] {
            if let Some(inner) = obj.get(wrapper) {
                if let Some(cmd) = extract_native_shell_command(inner) {
                    return Some(cmd);
                }
            }
        }
    }

    None
}

fn normalize_native_tool_key(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_')
        .collect()
}

/// 判断 ACP 原生工具是否为 shell/终端类。
pub fn is_native_shell_tool(name: &str, title: &str) -> bool {
    classify_native_tool(name, title) == NativeToolKind::Shell
}

/// 分类 ACP 原生工具，决定映射策略。
pub fn classify_native_tool(name: &str, title: &str) -> NativeToolKind {
    for label in [name, title] {
        let key = normalize_native_tool_key(label);
        if key.is_empty() {
            continue;
        }
        match key.as_str() {
            "shell" | "bash" | "terminal" | "runterminalcmd" | "runcommand" | "run_shell_command"
            | "powershell" | "pwsh" | "cmd" => return NativeToolKind::Shell,
            "websearch" | "web_search" | "searchweb" | "internetsearch" => {
                return NativeToolKind::WebSearch;
            }
            "webfetch" | "web_fetch" | "fetch" | "fetchurl" | "fetch_url" | "browse" => {
                return NativeToolKind::WebFetch;
            }
            "read" | "readfile" | "read_file" | "fileread" | "file_read" | "cat" => {
                return NativeToolKind::Read;
            }
            "write" | "writefile" | "write_file" | "filewrite" | "file_write" | "createfile"
            | "create_file" => return NativeToolKind::Write,
            "edit" | "editfile" | "edit_file" | "fileedit" | "file_edit" | "strreplace"
            | "str_replace" | "replace" => return NativeToolKind::Edit,
            "find" | "findfile" | "find_file" | "findfiles" | "find_files" | "filefind"
            | "file_find" => return NativeToolKind::Find,
            "grep" | "search" | "ripgrep" | "rg" | "codebasesearch" | "codebase_search" => {
                return NativeToolKind::Grep;
            }
            _ => {
                if key.contains("shell") || key.contains("terminal") || key.contains("powershell")
                {
                    return NativeToolKind::Shell;
                }
                if key.contains("websearch") || key.contains("web_search") {
                    return NativeToolKind::WebSearch;
                }
                if key.contains("webfetch") || key.contains("web_fetch") {
                    return NativeToolKind::WebFetch;
                }
            }
        }
    }
    NativeToolKind::Other
}

/// 从 rawInput 递归提取文件路径（支持 file_path / path / filePath / filename 等字段）。
fn extract_file_path(raw: &serde_json::Value) -> Option<String> {
    if let Some(s) = raw.as_str() {
        let trimmed = s.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('{') {
            return Some(trimmed.to_string());
        }
    }

    if let Some(obj) = raw.as_object() {
        for key in ["file_path", "path", "filePath", "filename", "file", "target"] {
            if let Some(v) = obj.get(key) {
                if let Some(s) = v.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
        // 递归查找 args / input 等嵌套对象
        for wrapper in ["args", "input", "params"] {
            if let Some(inner) = obj.get(wrapper) {
                if let Some(p) = extract_file_path(inner) {
                    return Some(p);
                }
            }
        }
    }

    None
}

/// 对路径进行 shell 转义，防止注入。
fn shell_escape(path: &str) -> String {
    if path.chars().all(|c| c.is_alphanumeric() || c == '/' || c == '\\' || c == '.' || c == '-' || c == '_') {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    }
}

/// 将原生 shell 工具映射为 `omni_terminal_run_terminal_command` 参数 JSON。
pub fn map_native_shell_to_terminal_tool(raw_input: &serde_json::Value) -> Option<String> {
    let command = extract_native_shell_command(raw_input)?;
    serde_json::to_string(&serde_json::json!({ "command": command })).ok()
}

/// 将原生 WebSearch 工具映射为 `omni_web_search` 参数 JSON。
pub fn map_native_web_search(raw: &serde_json::Value) -> Option<String> {
    let query = raw
        .get("query")
        .or_else(|| raw.get("search_query"))
        .or_else(|| raw.get("q"))
        .or_else(|| raw.get("keyword"))
        .and_then(|v| v.as_str())?
        .trim();
    if query.is_empty() {
        return None;
    }
    serde_json::to_string(&serde_json::json!({ "query": query })).ok()
}

/// 将原生 WebFetch 工具映射为 `omni_web_fetch` 参数 JSON。
pub fn map_native_web_fetch(raw: &serde_json::Value) -> Option<String> {
    let url = raw
        .get("url")
        .or_else(|| raw.get("href"))
        .or_else(|| raw.get("link"))
        .and_then(|v| v.as_str())?
        .trim();
    if url.is_empty() {
        return None;
    }
    serde_json::to_string(&serde_json::json!({ "url": url })).ok()
}

/// 将原生 Read 工具映射为 `omni_terminal_run_terminal_command { command: "cat path" }`。
pub fn map_native_read_to_terminal(raw: &serde_json::Value) -> Option<String> {
    let path = extract_file_path(raw)?;
    let cmd = format!("cat {}", shell_escape(&path));
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Write 工具映射为 `omni_terminal_run_terminal_command { command: "cat > path <<'EOF'...EOF" }`。
pub fn map_native_write_to_terminal(raw: &serde_json::Value) -> Option<String> {
    let path = extract_file_path(raw)?;
    let content = raw
        .get("content")
        .or_else(|| raw.get("new_string"))
        .or_else(|| raw.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cmd = format!(
        "cat > {} <<'OMNIEOF'\n{}\nOMNIEOF",
        shell_escape(&path),
        content
    );
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Edit 工具映射为 `omni_terminal_run_terminal_command`（用 perl -i 实现跨平台替换）。
pub fn map_native_edit_to_terminal(raw: &serde_json::Value) -> Option<String> {
    let path = extract_file_path(raw)?;
    let old = raw
        .get("old_string")
        .or_else(|| raw.get("find"))
        .or_else(|| raw.get("search"))
        .and_then(|v| v.as_str())?;
    let new = raw
        .get("new_string")
        .or_else(|| raw.get("replace"))
        .or_else(|| raw.get("replacement"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // 用 perl -i 实现跨平台原地替换（Git Bash / Linux / macOS 均自带 perl）
    let escaped_old = old.replace('\\', "\\\\").replace("'", "'\\''");
    let escaped_new = new.replace('\\', "\\\\").replace("'", "'\\''");
    let cmd = format!(
        "perl -i -pe 's/\\Q{}\\E/{}/g' {}",
        escaped_old,
        escaped_new,
        shell_escape(&path)
    );
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Find 工具映射为 `omni_terminal_run_terminal_command { command: "find path -name query" }`。
pub fn map_native_find_to_terminal(raw: &serde_json::Value) -> Option<String> {
    let query = raw
        .get("query")
        .or_else(|| raw.get("pattern"))
        .or_else(|| raw.get("name"))
        .and_then(|v| v.as_str())?
        .trim();
    if query.is_empty() {
        return None;
    }
    let path = extract_file_path(raw).unwrap_or_else(|| ".".to_string());
    let cmd = format!("find {} -name '{}'", shell_escape(&path), query.replace('\'', "'\\''"));
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Grep 工具映射为 `omni_terminal_run_terminal_command { command: "grep -rn pattern path" }`。
pub fn map_native_grep_to_terminal(raw: &serde_json::Value) -> Option<String> {
    let pattern = raw
        .get("pattern")
        .or_else(|| raw.get("regex"))
        .or_else(|| raw.get("query"))
        .or_else(|| raw.get("search"))
        .and_then(|v| v.as_str())?
        .trim();
    if pattern.is_empty() {
        return None;
    }
    let path = extract_file_path(raw).unwrap_or_else(|| ".".to_string());
    let cmd = format!("grep -rn '{}' {}", pattern.replace('\'', "'\\''"), shell_escape(&path));
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 根据工具分类返回映射后的工具名和参数 JSON。
/// 返回 (tool_name, arguments_json) 或 None（无法映射）。
pub fn map_native_tool_by_kind(
    kind: NativeToolKind,
    raw_input: &serde_json::Value,
) -> Option<(&'static str, String)> {
    match kind {
        NativeToolKind::Shell => {
            let args = map_native_shell_to_terminal_tool(raw_input)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::WebSearch => {
            let args = map_native_web_search(raw_input)?;
            Some((WEB_SEARCH_CLIENT_TOOL, args))
        }
        NativeToolKind::WebFetch => {
            let args = map_native_web_fetch(raw_input)?;
            Some((WEB_FETCH_CLIENT_TOOL, args))
        }
        NativeToolKind::Read => {
            let args = map_native_read_to_terminal(raw_input)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::Write => {
            let args = map_native_write_to_terminal(raw_input)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::Edit => {
            let args = map_native_edit_to_terminal(raw_input)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::Find => {
            let args = map_native_find_to_terminal(raw_input)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::Grep => {
            let args = map_native_grep_to_terminal(raw_input)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::Other => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_shell_tool_call_envelope() {
        let raw = serde_json::json!({
            "shellToolCall": { "args": { "command": "Get-Date -Format o" } }
        });
        assert_eq!(
            extract_native_shell_command(&raw).as_deref(),
            Some("Get-Date -Format o")
        );
    }

    #[test]
    fn extracts_powershell_script() {
        let raw = serde_json::json!({
            "script": "$lastYear = (Get-Date).AddYears(-1); Write-Output $lastYear"
        });
        assert!(extract_native_shell_command(&raw)
            .unwrap()
            .contains("AddYears"));
    }

    #[test]
    fn detects_powershell_title() {
        assert!(is_native_shell_tool("", "powershell"));
    }

    #[test]
    fn classifies_web_search() {
        assert_eq!(classify_native_tool("WebSearch", ""), NativeToolKind::WebSearch);
        assert_eq!(classify_native_tool("", "web_search"), NativeToolKind::WebSearch);
    }

    #[test]
    fn classifies_read() {
        assert_eq!(classify_native_tool("Read", ""), NativeToolKind::Read);
        assert_eq!(classify_native_tool("ReadFile", ""), NativeToolKind::Read);
    }

    #[test]
    fn classifies_edit() {
        assert_eq!(classify_native_tool("Edit", ""), NativeToolKind::Edit);
        assert_eq!(classify_native_tool("str_replace", ""), NativeToolKind::Edit);
    }

    #[test]
    fn maps_web_search() {
        let raw = serde_json::json!({ "query": "rust async" });
        let result = map_native_web_search(&raw).unwrap();
        assert!(result.contains("rust async"));
    }

    #[test]
    fn maps_read_to_cat() {
        let raw = serde_json::json!({ "file_path": "/tmp/test.txt" });
        let result = map_native_read_to_terminal(&raw).unwrap();
        assert!(result.contains("cat"));
        assert!(result.contains("/tmp/test.txt"));
    }

    #[test]
    fn maps_find_to_find_command() {
        let raw = serde_json::json!({ "query": "*.rs", "path": "/src" });
        let result = map_native_find_to_terminal(&raw).unwrap();
        assert!(result.contains("find"));
        assert!(result.contains("*.rs"));
    }

    #[test]
    fn maps_grep_to_grep_command() {
        let raw = serde_json::json!({ "pattern": "TODO", "path": "/src" });
        let result = map_native_grep_to_terminal(&raw).unwrap();
        assert!(result.contains("grep"));
        assert!(result.contains("TODO"));
    }

    #[test]
    fn maps_edit_to_perl() {
        let raw = serde_json::json!({
            "file_path": "/tmp/test.txt",
            "old_string": "foo",
            "new_string": "bar"
        });
        let result = map_native_edit_to_terminal(&raw).unwrap();
        assert!(result.contains("perl"));
        assert!(result.contains("foo"));
        assert!(result.contains("bar"));
    }

    #[test]
    fn extract_file_path_from_nested_args() {
        let raw = serde_json::json!({
            "args": { "file_path": "/nested/path.txt" }
        });
        assert_eq!(extract_file_path(&raw).as_deref(), Some("/nested/path.txt"));
    }
}

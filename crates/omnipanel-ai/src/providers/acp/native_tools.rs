//! 将 Cursor ACP 内置工具映射为 OmniPanel 客户端工具（对齐 cursor-gateway translator/native_tools）。
//!
//! 支持的原生工具分类：
//! - Shell: 映射为 `omni_terminal_exec`（当前绑定终端 PTY）
//! - WebSearch: 映射为 `omni_web_search`
//! - WebFetch: 映射为 `omni_web_fetch`
//! - Read/Write/Edit/Find/Grep: 有 `omni_files_*` 则映射 files；否则按当前 Tab shell
//!   选 `cat`/`Get-Content` 等，再走 `omni_terminal_exec`

pub const TERMINAL_CLIENT_TOOL: &str = "omni_terminal_exec";
pub const WEB_SEARCH_CLIENT_TOOL: &str = "omni_web_search";
pub const WEB_FETCH_CLIENT_TOOL: &str = "omni_web_fetch";
pub const FILES_READ_CLIENT_TOOL: &str = "omni_files_read";
pub const FILES_WRITE_CLIENT_TOOL: &str = "omni_files_write";
pub const FILES_SEARCH_CLIENT_TOOL: &str = "omni_files_search";
pub const LOCAL_FILES_CONNECTION_ID: &str = "__local__";

/// 本轮工具面 + 当前 Tab shell，决定 ACP 原生 Read/Write/Find 如何映射。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NativeMapHints {
    pub has_files_read: bool,
    pub has_files_write: bool,
    pub has_files_search: bool,
    pub powershell: bool,
}

impl NativeMapHints {
    pub fn from_tool_names<'a>(
        names: impl IntoIterator<Item = &'a str>,
        powershell: bool,
    ) -> Self {
        let mut hints = Self {
            powershell,
            ..Self::default()
        };
        for name in names {
            match name {
                FILES_READ_CLIENT_TOOL => hints.has_files_read = true,
                FILES_WRITE_CLIENT_TOOL => hints.has_files_write = true,
                FILES_SEARCH_CLIENT_TOOL => hints.has_files_search = true,
                _ => {}
            }
        }
        hints
    }

    pub fn powershell_from_terminal_context(ctx: Option<&str>) -> bool {
        ctx.unwrap_or("").to_ascii_lowercase().contains("powershell")
    }
}

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

/// 对路径进行 POSIX shell 转义，防止注入。
fn shell_escape(path: &str) -> String {
    if path.chars().all(|c| c.is_alphanumeric() || c == '/' || c == '\\' || c == '.' || c == '-' || c == '_') {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    }
}

/// PowerShell 单引号字面量。
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn files_args_read(path: &str) -> Option<String> {
    serde_json::to_string(&serde_json::json!({
        "connection_id": LOCAL_FILES_CONNECTION_ID,
        "path": path,
    }))
    .ok()
}

fn files_args_write(path: &str, content: &str) -> Option<String> {
    serde_json::to_string(&serde_json::json!({
        "connection_id": LOCAL_FILES_CONNECTION_ID,
        "path": path,
        "content": content,
    }))
    .ok()
}

fn files_args_search(query: &str, path: Option<&str>) -> Option<String> {
    let mut obj = serde_json::json!({
        "connection_id": LOCAL_FILES_CONNECTION_ID,
        "query": query,
    });
    if let Some(p) = path.filter(|s| !s.is_empty() && *s != ".") {
        obj["path"] = serde_json::Value::String(p.to_string());
    }
    serde_json::to_string(&obj).ok()
}

fn extract_write_content(raw: &serde_json::Value) -> String {
    raw.get("content")
        .or_else(|| raw.get("new_string"))
        .or_else(|| raw.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 将原生 shell 工具映射为 `omni_terminal_exec` 参数 JSON。
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

/// 将原生 Read 工具映射为当前 Tab 的读文件命令（POSIX `cat`）。
pub fn map_native_read_to_terminal(raw: &serde_json::Value) -> Option<String> {
    map_native_read_to_terminal_with_hints(raw, NativeMapHints::default())
}

pub fn map_native_read_to_terminal_with_hints(
    raw: &serde_json::Value,
    hints: NativeMapHints,
) -> Option<String> {
    let path = extract_file_path(raw)?;
    let cmd = if hints.powershell {
        format!("Get-Content -LiteralPath {}", powershell_quote(&path))
    } else {
        format!("cat {}", shell_escape(&path))
    };
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Write 工具映射为 POSIX heredoc 写文件。
pub fn map_native_write_to_terminal(raw: &serde_json::Value) -> Option<String> {
    map_native_write_to_terminal_with_hints(raw, NativeMapHints::default())
}

pub fn map_native_write_to_terminal_with_hints(
    raw: &serde_json::Value,
    hints: NativeMapHints,
) -> Option<String> {
    let path = extract_file_path(raw)?;
    let content = extract_write_content(raw);
    let cmd = if hints.powershell {
        format!(
            "@'\n{content}\n'@ | Set-Content -LiteralPath {} -Encoding utf8",
            powershell_quote(&path)
        )
    } else {
        format!(
            "cat > {} <<'OMNIEOF'\n{}\nOMNIEOF",
            shell_escape(&path),
            content
        )
    };
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Edit 工具映射为 `omni_terminal_exec`（perl / PowerShell -replace）。
pub fn map_native_edit_to_terminal(raw: &serde_json::Value) -> Option<String> {
    map_native_edit_to_terminal_with_hints(raw, NativeMapHints::default())
}

pub fn map_native_edit_to_terminal_with_hints(
    raw: &serde_json::Value,
    hints: NativeMapHints,
) -> Option<String> {
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
    let cmd = if hints.powershell {
        format!(
            "(Get-Content -LiteralPath {path} -Raw) -replace [regex]::Escape({old}), {new} | Set-Content -LiteralPath {path} -Encoding utf8 -NoNewline",
            path = powershell_quote(&path),
            old = powershell_quote(old),
            new = powershell_quote(new),
        )
    } else {
        let escaped_old = old.replace('\\', "\\\\").replace('\'', "'\\''");
        let escaped_new = new.replace('\\', "\\\\").replace('\'', "'\\''");
        format!(
            "perl -i -pe 's/\\Q{}\\E/{}/g' {}",
            escaped_old,
            escaped_new,
            shell_escape(&path)
        )
    };
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Find 工具映射为 POSIX `find`。
pub fn map_native_find_to_terminal(raw: &serde_json::Value) -> Option<String> {
    map_native_find_to_terminal_with_hints(raw, NativeMapHints::default())
}

pub fn map_native_find_to_terminal_with_hints(
    raw: &serde_json::Value,
    hints: NativeMapHints,
) -> Option<String> {
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
    let cmd = if hints.powershell {
        format!(
            "Get-ChildItem -LiteralPath {} -Filter {} -Recurse -Name",
            powershell_quote(&path),
            powershell_quote(query)
        )
    } else {
        format!(
            "find {} -name '{}'",
            shell_escape(&path),
            query.replace('\'', "'\\''")
        )
    };
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 将原生 Grep 工具映射为 POSIX `grep`。
pub fn map_native_grep_to_terminal(raw: &serde_json::Value) -> Option<String> {
    map_native_grep_to_terminal_with_hints(raw, NativeMapHints::default())
}

pub fn map_native_grep_to_terminal_with_hints(
    raw: &serde_json::Value,
    hints: NativeMapHints,
) -> Option<String> {
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
    let cmd = if hints.powershell {
        format!(
            "Get-ChildItem -LiteralPath {} -Recurse -File | Select-String -Pattern {}",
            powershell_quote(&path),
            powershell_quote(pattern)
        )
    } else {
        format!(
            "grep -rn '{}' {}",
            pattern.replace('\'', "'\\''"),
            shell_escape(&path)
        )
    };
    serde_json::to_string(&serde_json::json!({ "command": cmd })).ok()
}

/// 根据工具分类返回映射后的工具名和参数 JSON。
/// 返回 (tool_name, arguments_json) 或 None（无法映射）。
pub fn map_native_tool_by_kind(
    kind: NativeToolKind,
    raw_input: &serde_json::Value,
) -> Option<(&'static str, String)> {
    map_native_tool_by_kind_with_hints(kind, raw_input, NativeMapHints::default())
}

pub fn map_native_tool_by_kind_with_hints(
    kind: NativeToolKind,
    raw_input: &serde_json::Value,
    hints: NativeMapHints,
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
            if hints.has_files_read {
                let path = extract_file_path(raw_input)?;
                let args = files_args_read(&path)?;
                Some((FILES_READ_CLIENT_TOOL, args))
            } else {
                let args = map_native_read_to_terminal_with_hints(raw_input, hints)?;
                Some((TERMINAL_CLIENT_TOOL, args))
            }
        }
        NativeToolKind::Write => {
            if hints.has_files_write {
                let path = extract_file_path(raw_input)?;
                let args = files_args_write(&path, &extract_write_content(raw_input))?;
                Some((FILES_WRITE_CLIENT_TOOL, args))
            } else {
                let args = map_native_write_to_terminal_with_hints(raw_input, hints)?;
                Some((TERMINAL_CLIENT_TOOL, args))
            }
        }
        NativeToolKind::Edit => {
            let args = map_native_edit_to_terminal_with_hints(raw_input, hints)?;
            Some((TERMINAL_CLIENT_TOOL, args))
        }
        NativeToolKind::Find => {
            if hints.has_files_search {
                let query = raw_input
                    .get("query")
                    .or_else(|| raw_input.get("pattern"))
                    .or_else(|| raw_input.get("name"))
                    .and_then(|v| v.as_str())?
                    .trim();
                if query.is_empty() {
                    return None;
                }
                let path = extract_file_path(raw_input);
                let args = files_args_search(query, path.as_deref())?;
                Some((FILES_SEARCH_CLIENT_TOOL, args))
            } else {
                let args = map_native_find_to_terminal_with_hints(raw_input, hints)?;
                Some((TERMINAL_CLIENT_TOOL, args))
            }
        }
        NativeToolKind::Grep => {
            let args = map_native_grep_to_terminal_with_hints(raw_input, hints)?;
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

    #[test]
    fn maps_read_to_files_when_available() {
        let raw = serde_json::json!({ "file_path": "/tmp/test.txt" });
        let hints = NativeMapHints {
            has_files_read: true,
            ..NativeMapHints::default()
        };
        let (name, args) = map_native_tool_by_kind_with_hints(NativeToolKind::Read, &raw, hints).unwrap();
        assert_eq!(name, FILES_READ_CLIENT_TOOL);
        assert!(args.contains("__local__"));
        assert!(args.contains("/tmp/test.txt"));
        assert!(!args.contains("cat"));
    }

    #[test]
    fn maps_write_to_files_when_available() {
        let raw = serde_json::json!({ "path": "C:\\\\tmp\\\\a.txt", "content": "hi" });
        let hints = NativeMapHints {
            has_files_write: true,
            ..NativeMapHints::default()
        };
        let (name, args) = map_native_tool_by_kind_with_hints(NativeToolKind::Write, &raw, hints).unwrap();
        assert_eq!(name, FILES_WRITE_CLIENT_TOOL);
        assert!(args.contains("hi"));
        assert!(args.contains("__local__"));
    }

    #[test]
    fn maps_read_to_get_content_on_powershell() {
        let raw = serde_json::json!({ "file_path": "C:\\\\tmp\\\\test.txt" });
        let hints = NativeMapHints {
            powershell: true,
            ..NativeMapHints::default()
        };
        let (name, args) = map_native_tool_by_kind_with_hints(NativeToolKind::Read, &raw, hints).unwrap();
        assert_eq!(name, TERMINAL_CLIENT_TOOL);
        assert!(args.contains("Get-Content"));
        assert!(!args.contains("cat "));
    }

    #[test]
    fn maps_find_to_files_search_when_available() {
        let raw = serde_json::json!({ "query": "*.rs", "path": "/src" });
        let hints = NativeMapHints {
            has_files_search: true,
            ..NativeMapHints::default()
        };
        let (name, args) = map_native_tool_by_kind_with_hints(NativeToolKind::Find, &raw, hints).unwrap();
        assert_eq!(name, FILES_SEARCH_CLIENT_TOOL);
        assert!(args.contains("*.rs"));
        assert!(args.contains("__local__"));
    }

    #[test]
    fn from_tool_names_detects_files_and_powershell_context() {
        let hints = NativeMapHints::from_tool_names(
            ["omni_files_read", "omni_terminal_exec"],
            NativeMapHints::powershell_from_terminal_context(Some("Shell: PowerShell")),
        );
        assert!(hints.has_files_read);
        assert!(!hints.has_files_write);
        assert!(hints.powershell);
    }
}

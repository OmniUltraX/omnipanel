use std::fs;
use std::path::PathBuf;

/// 将文本写入用户通过 `plugin-dialog::save` 选择的任意路径。
///
/// Tauri 2 的 `plugin-fs` 默认只允许在 capability scope 内的目录写入；本命令直接调用 std::fs
/// 绕开范围限制，调用方必须已通过 save dialog 拿到用户明确授权的路径。
#[tauri::command]
#[specta::specta]
pub async fn write_text_file(path: String, contents: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("未指定文件路径".to_string());
    }
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    fs::write(&target, contents.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

//! pane / window 与 OmniPanel 会话之间的双向映射。
//!
//! 每个远程终端 Tab 对应一个 tmux window，window 内只有一个 pane
//! （见 design.md D1：pane 尺寸受布局强耦合，无法逐 Tab 独立控尺）。
//! 因此三者是一一对应关系，本注册表负责在收到 `%output %N` 时反查该把字节
//! 送给哪个前端会话。

use std::collections::HashMap;

use super::parser::{PaneId, WindowId};

/// 一个远程终端 Tab 在 tmux 侧的落点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneEntry {
    /// OmniPanel 会话标识（如 `ssh-3`）。
    pub session_id: String,
    pub window: WindowId,
    pub pane: PaneId,
}

/// pane ↔ 会话、window ↔ 会话 的双向索引。
#[derive(Debug, Default)]
pub struct PaneRegistry {
    by_session: HashMap<String, PaneEntry>,
    by_pane: HashMap<PaneId, String>,
    by_window: HashMap<WindowId, String>,
}

impl PaneRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一个会话。同名会话重复登记时，旧的 pane / window 索引会被清理，
    /// 避免重连场景下残留指向已销毁 pane 的映射。
    pub fn register(&mut self, session_id: impl Into<String>, window: WindowId, pane: PaneId) {
        let session_id = session_id.into();
        if let Some(old) = self.by_session.remove(&session_id) {
            self.by_pane.remove(&old.pane);
            self.by_window.remove(&old.window);
        }
        self.by_pane.insert(pane, session_id.clone());
        self.by_window.insert(window, session_id.clone());
        self.by_session.insert(
            session_id.clone(),
            PaneEntry {
                session_id,
                window,
                pane,
            },
        );
    }

    /// 按会话反注册，返回被移除的条目。
    pub fn unregister(&mut self, session_id: &str) -> Option<PaneEntry> {
        let entry = self.by_session.remove(session_id)?;
        self.by_pane.remove(&entry.pane);
        self.by_window.remove(&entry.window);
        Some(entry)
    }

    /// 按 window 反注册（收到 `%window-close` 时使用）。
    pub fn remove_window(&mut self, window: WindowId) -> Option<PaneEntry> {
        let session_id = self.by_window.get(&window)?.clone();
        self.unregister(&session_id)
    }

    pub fn entry(&self, session_id: &str) -> Option<&PaneEntry> {
        self.by_session.get(session_id)
    }

    /// 收到 `%output %N` 时反查目标会话。
    pub fn session_of_pane(&self, pane: PaneId) -> Option<&str> {
        self.by_pane.get(&pane).map(String::as_str)
    }

    pub fn session_of_window(&self, window: WindowId) -> Option<&str> {
        self.by_window.get(&window).map(String::as_str)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.by_session.contains_key(session_id)
    }

    pub fn len(&self) -> usize {
        self.by_session.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_session.is_empty()
    }

    /// 当前登记的全部会话标识，用于连接断开时批量通知。
    pub fn session_ids(&self) -> Vec<String> {
        self.by_session.keys().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.by_session.clear();
        self.by_pane.clear();
        self.by_window.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_with_two() -> PaneRegistry {
        let mut r = PaneRegistry::new();
        r.register("ssh-1", WindowId(0), PaneId(0));
        r.register("ssh-2", WindowId(1), PaneId(1));
        r
    }

    #[test]
    fn resolves_session_from_pane_and_window() {
        let r = registry_with_two();
        assert_eq!(r.session_of_pane(PaneId(0)), Some("ssh-1"));
        assert_eq!(r.session_of_pane(PaneId(1)), Some("ssh-2"));
        assert_eq!(r.session_of_window(WindowId(1)), Some("ssh-2"));
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn unknown_pane_resolves_to_none() {
        let r = registry_with_two();
        assert_eq!(r.session_of_pane(PaneId(99)), None);
        assert_eq!(r.session_of_window(WindowId(99)), None);
        assert!(!r.contains("ssh-9"));
    }

    #[test]
    fn unregister_clears_all_three_indexes() {
        let mut r = registry_with_two();
        let removed = r.unregister("ssh-1").unwrap();
        assert_eq!(removed.pane, PaneId(0));
        assert_eq!(removed.window, WindowId(0));
        assert_eq!(r.session_of_pane(PaneId(0)), None);
        assert_eq!(r.session_of_window(WindowId(0)), None);
        assert!(!r.contains("ssh-1"));
        assert_eq!(r.len(), 1);
        assert_eq!(r.unregister("ssh-1"), None);
    }

    #[test]
    fn remove_window_maps_back_to_session() {
        let mut r = registry_with_two();
        let removed = r.remove_window(WindowId(1)).unwrap();
        assert_eq!(removed.session_id, "ssh-2");
        assert_eq!(r.session_of_pane(PaneId(1)), None);
        assert_eq!(r.remove_window(WindowId(1)), None);
    }

    #[test]
    fn re_registering_same_session_drops_stale_indexes() {
        let mut r = registry_with_two();
        // 重连后同一会话落到新的 window/pane
        r.register("ssh-1", WindowId(5), PaneId(7));
        assert_eq!(r.len(), 2, "不应产生重复会话");
        assert_eq!(
            r.session_of_pane(PaneId(0)),
            None,
            "旧 pane 索引必须清理，否则会把新输出投递到已销毁的 pane"
        );
        assert_eq!(r.session_of_window(WindowId(0)), None);
        assert_eq!(r.session_of_pane(PaneId(7)), Some("ssh-1"));
        assert_eq!(r.entry("ssh-1").unwrap().window, WindowId(5));
    }

    #[test]
    fn session_ids_lists_everything_for_broadcast() {
        let r = registry_with_two();
        let mut ids = r.session_ids();
        ids.sort();
        assert_eq!(ids, vec!["ssh-1".to_string(), "ssh-2".to_string()]);
    }

    #[test]
    fn clear_empties_registry() {
        let mut r = registry_with_two();
        r.clear();
        assert!(r.is_empty());
        assert_eq!(r.session_of_pane(PaneId(0)), None);
    }
}

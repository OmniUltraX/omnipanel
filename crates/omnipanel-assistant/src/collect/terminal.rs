use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

pub struct TerminalCollector;

impl MetadataCollector for TerminalCollector {
    fn module_id(&self) -> &'static str {
        "terminal"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        // 同时下发 SSH 连接 + 终端会话；助手端双 Tab 按 kind 过滤
        let mut items: Vec<_> = ctx.terminal_hosts.iter().map(strip_secret_keys).collect();
        items.extend(ctx.terminal_sessions.iter().map(strip_secret_keys));
        Ok(ModuleSection::from_items(items))
    }
}

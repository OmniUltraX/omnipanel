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
        // 优先终端会话；无会话时再回退 SSH 主机列表（旧客户端兼容）
        let source = if !ctx.terminal_sessions.is_empty() {
            &ctx.terminal_sessions
        } else {
            &ctx.terminal_hosts
        };
        let items = source.iter().map(strip_secret_keys).collect();
        Ok(ModuleSection::from_items(items))
    }
}

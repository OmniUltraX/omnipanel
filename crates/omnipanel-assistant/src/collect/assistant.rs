use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

/// AI 助手会话列表（仅元数据，不含消息正文）。
pub struct AssistantCollector;

impl MetadataCollector for AssistantCollector {
    fn module_id(&self) -> &'static str {
        "assistant"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx
            .assistant_conversations
            .iter()
            .map(strip_secret_keys)
            .collect();
        Ok(ModuleSection::from_items(items))
    }
}

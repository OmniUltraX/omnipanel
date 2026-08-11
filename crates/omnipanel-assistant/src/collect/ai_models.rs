use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

/// AI 模型目录（脱敏，不含 API Key）。
pub struct AiModelsCollector;

impl MetadataCollector for AiModelsCollector {
    fn module_id(&self) -> &'static str {
        "aiModels"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx.ai_models.iter().map(strip_secret_keys).collect();
        Ok(ModuleSection::from_items(items))
    }
}

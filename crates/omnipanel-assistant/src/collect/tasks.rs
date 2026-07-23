use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

pub struct TasksCollector;

impl MetadataCollector for TasksCollector {
    fn module_id(&self) -> &'static str {
        "tasks"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx
            .recent_tasks
            .iter()
            .take(5)
            .map(strip_secret_keys)
            .collect();
        Ok(ModuleSection::from_items(items))
    }
}

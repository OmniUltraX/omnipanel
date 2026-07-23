use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

pub struct DatabaseCollector;

impl MetadataCollector for DatabaseCollector {
    fn module_id(&self) -> &'static str {
        "database"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx
            .database_connections
            .iter()
            .map(strip_secret_keys)
            .collect();
        Ok(ModuleSection::from_items(items))
    }
}

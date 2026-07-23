use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

pub struct ServerCollector;

impl MetadataCollector for ServerCollector {
    fn module_id(&self) -> &'static str {
        "server"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx
            .server_panels
            .iter()
            .map(strip_secret_keys)
            .collect();
        Ok(ModuleSection::from_items(items))
    }
}

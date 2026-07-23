use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

pub struct DockerCollector;

impl MetadataCollector for DockerCollector {
    fn module_id(&self) -> &'static str {
        "docker"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx
            .docker_instances
            .iter()
            .map(strip_secret_keys)
            .collect();
        Ok(ModuleSection::from_items(items))
    }
}

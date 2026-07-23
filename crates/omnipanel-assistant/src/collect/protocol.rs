use omnipanel_error::OmniResult;

use super::{CollectContext, MetadataCollector};
use crate::sanitize::strip_secret_keys;
use crate::types::ModuleSection;

pub struct ProtocolCollector;

impl MetadataCollector for ProtocolCollector {
    fn module_id(&self) -> &'static str {
        "protocol"
    }

    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection> {
        let items = ctx
            .protocol_requests
            .iter()
            .map(strip_secret_keys)
            .collect();
        Ok(ModuleSection::from_items(items))
    }
}

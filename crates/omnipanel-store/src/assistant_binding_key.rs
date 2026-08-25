//! 助手绑定公钥：按 `bind_id` 存于本机 Vault（PC 加密助手摘要时使用）。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};

fn vault_ref(bind_id: &str) -> String {
    format!("__assistant_binding_pubkey__:{bind_id}")
}

pub fn store_assistant_binding_pubkey(bind_id: &str, pubkey_b64: &str) -> OmniResult<()> {
    let bind_id = bind_id.trim();
    let pubkey_b64 = pubkey_b64.trim();
    if bind_id.is_empty() || pubkey_b64.is_empty() {
        return Err(OmniError::invalid_input("bind_id 或公钥无效"));
    }
    crate::Vault::store(&vault_ref(bind_id), pubkey_b64)
}

pub fn load_assistant_binding_pubkey(bind_id: &str) -> OmniResult<Option<String>> {
    let bind_id = bind_id.trim();
    if bind_id.is_empty() {
        return Err(OmniError::invalid_input("bind_id 无效"));
    }
    match crate::Vault::get(&vault_ref(bind_id)) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn clear_assistant_binding_pubkey(bind_id: &str) -> OmniResult<()> {
    crate::Vault::delete(&vault_ref(bind_id.trim()))
}

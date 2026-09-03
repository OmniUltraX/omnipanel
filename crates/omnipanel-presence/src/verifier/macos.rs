use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use omnipanel_error::OmniResult;

use crate::presence_denied;
use crate::verifier::{PresenceCapability, PresenceKind, PresenceVerifier};

pub struct MacOsVerifier;

impl PresenceVerifier for MacOsVerifier {
    fn status(&self) -> PresenceCapability {
        let available = can_evaluate().unwrap_or(false);
        PresenceCapability {
            available,
            kind: if available {
                PresenceKind::TouchId
            } else {
                PresenceKind::None
            },
        }
    }

    fn verify(&self, reason: &str, _native_window: Option<isize>) -> OmniResult<()> {
        evaluate(reason)
    }
}

fn can_evaluate() -> Result<bool, String> {
    let ctx = unsafe { LAContext::new() };
    let ok = unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_ok();
    Ok(ok)
}

fn evaluate(reason: &str) -> OmniResult<()> {
    if !can_evaluate().unwrap_or(false) {
        return Err(presence_denied("本机不支持系统验证"));
    }
    let ctx = unsafe { LAContext::new() };
    let (tx, rx) = mpsc::channel();
    let reason = NSString::from_str(reason);
    let block = RcBlock::new(move |success: Bool, error: *mut NSError| {
        if success.as_bool() {
            let _ = tx.send(Ok(()));
            return;
        }
        let canceled = unsafe { error.as_ref() }
            .map(|e| e.code() == -2 || e.code() == -4)
            .unwrap_or(false);
        let _ = tx.send(Err(if canceled {
            presence_denied("用户取消了系统验证")
        } else {
            presence_denied("系统验证未通过")
        }));
    });
    unsafe {
        ctx.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthentication,
            &reason,
            &block,
        );
    }
    rx.recv_timeout(Duration::from_secs(120))
        .map_err(|_| presence_denied("系统验证超时"))?
}

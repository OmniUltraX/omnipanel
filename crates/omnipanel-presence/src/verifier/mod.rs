use omnipanel_error::OmniResult;
use serde::Serialize;
use specta::Type;

use crate::presence_denied;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PresenceKind {
    None,
    Hello,
    TouchId,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PresenceCapability {
    pub available: bool,
    pub kind: PresenceKind,
}

pub trait PresenceVerifier: Send + Sync {
    fn status(&self) -> PresenceCapability;
    fn verify(&self, reason: &str, native_window: Option<isize>) -> OmniResult<()>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableVerifier;

impl PresenceVerifier for UnavailableVerifier {
    fn status(&self) -> PresenceCapability {
        PresenceCapability {
            available: false,
            kind: PresenceKind::None,
        }
    }

    fn verify(&self, _reason: &str, _native_window: Option<isize>) -> OmniResult<()> {
        Err(presence_denied("本机不支持系统验证"))
    }
}

#[cfg(windows)]
mod windows_hello;

#[cfg(target_os = "macos")]
mod macos;

pub fn platform_verifier() -> Box<dyn PresenceVerifier> {
    #[cfg(windows)]
    {
        return Box::new(windows_hello::WindowsHelloVerifier);
    }
    #[cfg(target_os = "macos")]
    {
        return Box::new(macos::MacOsVerifier);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Box::new(UnavailableVerifier)
    }
}

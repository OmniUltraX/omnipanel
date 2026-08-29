use std::ffi::c_void;

use omnipanel_error::OmniResult;
use windows::Foundation::IAsyncOperation;
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows::core::HSTRING;

use crate::presence_denied;
use crate::verifier::{PresenceCapability, PresenceKind, PresenceVerifier};

pub struct WindowsHelloVerifier;

impl PresenceVerifier for WindowsHelloVerifier {
    fn status(&self) -> PresenceCapability {
        let available = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.get())
            .map(|a| a == UserConsentVerifierAvailability::Available)
            .unwrap_or(false);
        PresenceCapability {
            available,
            kind: if available {
                PresenceKind::Hello
            } else {
                PresenceKind::None
            },
        }
    }

    fn verify(&self, reason: &str, native_window: Option<isize>) -> OmniResult<()> {
        if !self.status().available {
            return Err(presence_denied("本机未启用 Windows Hello"));
        }
        let hwnd = native_window.unwrap_or(0);
        let result = request_for_window(reason, hwnd)?;
        match result {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => Err(presence_denied("用户取消了系统验证")),
            _ => Err(presence_denied("系统验证未通过")),
        }
    }
}

fn request_for_window(reason: &str, hwnd: isize) -> OmniResult<UserConsentVerificationResult> {
    let interop: IUserConsentVerifierInterop =
        windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|e| presence_denied(format!("无法调起 Windows Hello: {e}")))?;
    let hwnd = HWND(hwnd as *mut c_void);
    let op: IAsyncOperation<UserConsentVerificationResult> = unsafe {
        interop.RequestVerificationForWindowAsync(hwnd, &HSTRING::from(reason))
    }
    .map_err(|e| presence_denied(format!("调起系统验证失败: {e}")))?;
    op.get()
        .map_err(|e| presence_denied(format!("系统验证失败: {e}")))
}

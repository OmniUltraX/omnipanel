//! Windows WebView2 跨显示器 DPI 控制。
//!
//! 默认 WebView2 会在跨屏时自行改 RasterizationScale，中间容易闪出未绘制区。
//! 这里关闭自动跟踪，改由窗口 `ScaleFactorChanged` 事件驱动一次同步更新，
//! 避免与前端遮罩 / 强制 reflow 叠加重影。

#![cfg(windows)]

use tauri::{WebviewWindow, WindowEvent};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
use windows::core::Interface;

fn with_controller3(
  window: &WebviewWindow,
  f: impl FnOnce(&ICoreWebView2Controller3) + Send + 'static,
) {
  let _ = window.with_webview(move |platform| {
    let controller = platform.controller();
    match controller.cast::<ICoreWebView2Controller3>() {
      Ok(c3) => f(&c3),
      Err(err) => tracing::warn!("WebView2 Controller3 unavailable: {err}"),
    }
  });
}

fn set_rasterization_scale(window: &WebviewWindow, scale: f64) {
  let label = window.label().to_string();
  with_controller3(window, move |c3| unsafe {
    let _ = c3.SetShouldDetectMonitorScaleChanges(false);
    if let Err(err) = c3.SetRasterizationScale(scale) {
      tracing::warn!("SetRasterizationScale({scale}) failed ({label}): {err}");
    }
  });
}

/// 关闭自动 DPI 跟踪并同步到当前窗口 scale。
pub fn configure_webview_dpi(window: &WebviewWindow) {
  let scale = window.scale_factor().unwrap_or(1.0);
  set_rasterization_scale(window, scale);
}

/// 监听跨屏 DPI：由我们一次性写 RasterizationScale（不再盖前端遮罩）。
pub fn attach_webview_dpi_handlers(window: &WebviewWindow) {
  configure_webview_dpi(window);

  let win = window.clone();
  window.on_window_event(move |event| {
    if let WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
      set_rasterization_scale(&win, *scale_factor);
    }
  });
}

pub fn hook_window(window: &WebviewWindow) {
  attach_webview_dpi_handlers(window);
}

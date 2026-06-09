use windows_sys::Win32::UI::WindowsAndMessaging::*;

/// No separate overlay window needed — mpv renders directly
/// into the main Tauri window. The WebView2 sits on top with a
/// transparent background; CSS controls which parts are see-through.
pub struct VideoOverlay {
    pub main_hwnd: isize,
}

impl VideoOverlay {
    pub fn create(main_hwnd: isize) -> Result<Self, String> {
        // We don't create a window. mpv uses the main HWND directly.
        Ok(VideoOverlay { main_hwnd })
    }

    pub fn hwnd(&self) -> isize {
        self.main_hwnd
    }

    /// No-op: mpv renders to the main window which is always the right size.
    pub fn place(&self, _parent_hwnd: isize, _x: i32, _y: i32, _width: i32, _height: i32) {}

    pub fn show(&self) {}
    pub fn hide(&self) {}
}

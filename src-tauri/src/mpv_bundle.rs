use std::path::PathBuf;

/// Ensure mpv DLLs are available for the native player.
///
/// For dev builds: DLLs are copied by `build.rs` from `src-tauri/mpv/`
/// to the output directory, so Windows finds `mpv-2.dll` in the exe
/// directory automatically.
///
/// For production: DLLs are bundled alongside the installer.
/// Stremio-style zip embedding can be added here in the future.
///
/// Returns the directory where DLLs are expected, or `None` if no
/// bundle strategy is active.
pub fn ensure_mpv_dlls(app_data_dir: &std::path::Path) -> Option<PathBuf> {
    let _ = app_data_dir;
    None
}

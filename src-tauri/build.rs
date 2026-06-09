fn main() {
    // Load .env file variables into the environment if the file exists
    if let Err(e) = dotenvy::dotenv() {
        println!("cargo:warning=Failed to load .env file: {}", e);
    }

    // Make specific environment variables available at compile time
    // This allows using option_env!("VAR_NAME") in the code
    let vars_to_embed = [
        "GDRIVE_CLIENT_ID",
        "GDRIVE_CLIENT_SECRET",
        "GDRIVE_REDIRECT_URI",
    ];

    for var in vars_to_embed {
        if let Ok(val) = std::env::var(var) {
            println!("cargo:rustc-env={}={}", var, val);
        } else {
            println!("cargo:warning=Environment variable {} not found", var);
        }
        // Re-run build script if these vars change
        println!("cargo:rerun-if-env-changed={}", var);
    }

    // Also rerun if .env changes
    println!("cargo:rerun-if-changed=.env");

    // ============================================================
    // Bundle mpv DLLs for native player (libmpv)
    // ============================================================
    // Copy all DLLs from src-tauri/mpv/ to the output directory so
    // Windows finds mpv-2.dll and its dependencies at runtime.
    // For dev: just drop mpv-2.dll + deps into src-tauri/mpv/.
    // For production: these will be bundled alongside the installer.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let mpv_dir = std::path::Path::new(&manifest_dir).join("mpv");

    if mpv_dir.exists() && mpv_dir.is_dir() {
        let out_dir = std::env::var("OUT_DIR").unwrap();
        let out_path = std::path::Path::new(&out_dir);

        // Navigate up from OUT_DIR to reach the profile directory:
        //   OUT_DIR = target/{profile}/build/{crate}-{hash}/out
        // We want  target/{profile}/
        let profile_dir = out_path
            .parent() // target/{profile}/build/{crate}-{hash}
            .and_then(|p| p.parent()) // target/{profile}/build
            .and_then(|p| p.parent()); // target/{profile}

        if let Some(dest_base) = profile_dir {
            for entry in std::fs::read_dir(&mpv_dir).unwrap() {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if ext == "dll" || ext == "lib" {
                        let dest = dest_base.join(path.file_name().unwrap());
                        println!("cargo:warning=Copying mpv bundle: {} -> {}", path.display(), dest.display());
                        std::fs::copy(&path, &dest).ok();
                    }
                }
            }
            // Tell the linker to search in the profile directory for mpv.lib
            println!("cargo:rustc-link-search={}", dest_base.display());
            println!("cargo:rerun-if-changed={}", mpv_dir.display());
        }
    } else {
        println!("cargo:warning=mpv/ directory not found at {}. Native player will need mpv-2.dll on PATH or in the exe directory.", mpv_dir.display());
    }

    // ============================================================
    // Embed mpv zip archive for runtime extraction (stremio style)
    // ============================================================
    let mpv_zip = std::path::Path::new(&manifest_dir).join("resources").join("mpv.zip");
    if mpv_zip.exists() {
        println!("cargo:rerun-if-changed={}", mpv_zip.display());
        // Emit a cfg flag so Rust code can conditionally include the bytes
        println!("cargo:rustc-cfg=mpv_zip_embedded");
    }

    tauri_build::build()
}

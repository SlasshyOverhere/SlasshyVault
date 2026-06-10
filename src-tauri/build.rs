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

    tauri_build::build()
}

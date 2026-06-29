fn main() {
    let exe = r#"C:\Program Files\App$(calc.exe).exe"#;
    let b64 = {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        STANDARD.encode(exe)
    };
    println!("Base64: {}", b64);
}

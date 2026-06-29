fn main() {
    let exe = r#"C:\evil path $(calc.exe) ' " \app.exe"#;
    let rule_name = "SlasshyVault ZIP Proxy";
    let port = 49152;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let b64_exe = STANDARD.encode(exe.as_bytes());

    let netsh_script = format!(
        "$exe = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{}'));\n\
         netsh advfirewall firewall delete rule name=\"{}\";\n\
         netsh advfirewall firewall add rule name=\"{}\" dir=in action=allow protocol=TCP localport={} program=$exe remoteip=127.0.0.1,::1 enable=yes",
        b64_exe,
        rule_name,
        rule_name,
        port
    );

    let mut encoded = Vec::new();
    for c in netsh_script.encode_utf16() {
        encoded.extend_from_slice(&c.to_le_bytes());
    }
    let b64_script = STANDARD.encode(&encoded);

    let ps = format!(
        "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-EncodedCommand','{}')",
        b64_script
    );

    println!("netsh_script:\n{}", netsh_script);
    println!("\nps:\n{}", ps);
}

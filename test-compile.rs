use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

fn main() {
    let rule_name = "SlasshyVault ZIP Proxy";
    let exe = r#"C:\Program Files\Evil$(calc.exe).exe"#;
    let port = 49152;

    let exe_b64 = BASE64.encode(exe.as_bytes());

    let inner_script = format!(
        "$rule = '{}';\n\
         $exe = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{}'));\n\
         netsh advfirewall firewall delete rule name=$rule;\n\
         netsh advfirewall firewall add rule name=$rule dir=in action=allow protocol=TCP localport={} program=$exe remoteip=127.0.0.1,::1 enable=yes",
        rule_name, exe_b64, port
    );

    let mut encoded_script = Vec::new();
    for c in inner_script.encode_utf16() {
        encoded_script.extend_from_slice(&c.to_le_bytes());
    }
    let inner_b64 = BASE64.encode(&encoded_script);

    let ps = format!(
        "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', '{}')",
        inner_b64
    );

    println!("{}", ps);
}

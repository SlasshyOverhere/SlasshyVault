## 2024-05-24 - [Fix Command Injection in PowerShell Expand-Archive]
**Vulnerability:** Command injection when dynamically constructing a PowerShell script containing arbitrary file paths to execute `Expand-Archive`.
**Learning:** `std::process::Command` in Rust passes arguments directly, but when passing a single formatted string to `powershell -Command`, PowerShell evaluates the entire string, allowing execution of embedded subexpressions (e.g. `$(...)`). Even if wrapped in quotes, it can be bypassed or misinterpreted depending on spaces and PowerShell parsing rules.
**Prevention:** Never pass untrusted strings into `-Command`. Pass them securely as environment variables using `.env("VAR", val)` and reference them securely in the script via `$env:VAR`.

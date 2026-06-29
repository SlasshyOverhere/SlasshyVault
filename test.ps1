$script = 'param($a, $b); Write-Host "a: $a, b: $b"'
$bytes = [System.Text.Encoding]::Unicode.GetBytes($script)
$b64 = [Convert]::ToBase64String($bytes)
powershell.exe -EncodedCommand $b64 "hello" "world"

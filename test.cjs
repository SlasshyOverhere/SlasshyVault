const b64 = Buffer.from('C:\\path with spaces\\app.exe').toString('base64');
const script = `
$exe = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'));
Write-Host "program=$exe"
`;
console.log(script);

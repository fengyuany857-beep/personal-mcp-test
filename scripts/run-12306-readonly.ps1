$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required on PATH."
}

$stateDir = Join-Path $env:LOCALAPPDATA "PersonalMCP\12306"
$keyFile = Join-Path $stateDir "passenger-alias-key.dpapi"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if (-not (Test-Path $keyFile)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $plain = [Convert]::ToBase64String($bytes)
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString $secure
    Set-Content -Path $keyFile -Value $encrypted -Encoding UTF8
}

$encryptedKey = (Get-Content -Path $keyFile -Raw).Trim()
$secureKey = ConvertTo-SecureString $encryptedKey
$credential = New-Object System.Management.Automation.PSCredential("local", $secureKey)
$env:RAIL12306_ALIAS_KEY = $credential.GetNetworkCredential().Password

try {
    node --experimental-strip-types scripts/12306-local-readonly.ts
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Remove-Item Env:RAIL12306_ALIAS_KEY -ErrorAction SilentlyContinue
}

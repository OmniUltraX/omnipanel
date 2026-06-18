# Validate Tauri updater signing key without a full build.
# Usage:
#   cd frontend && npm run validate-signing
#   .\scripts\validate-signing-key.ps1
#   .\scripts\validate-signing-key.ps1 -KeyPath "D:\omnipanel\frontend\tauri-signing.key"
#   .\scripts\validate-signing-key.ps1 -SecretFile "D:\temp\gh-updater-key.txt"

param(
    [string]$KeyPath = "",
    [string]$SecretFile = "",
    [string]$Password = [string]::Empty
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$FrontendDir = Join-Path $RepoRoot "frontend"
$TauriConf = Join-Path $RepoRoot "src-tauri\tauri.conf.json"
$DefaultKeyPath = Join-Path $FrontendDir "tauri-signing.key"
$DefaultPubPath = Join-Path $FrontendDir "tauri-signing.key.pub"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host ">> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Fail([string]$Message) {
    Write-Host "FAIL $Message" -ForegroundColor Red
}

function Test-Base64File([string]$Path) {
    $content = (Get-Content -LiteralPath $Path -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "Key file is empty"
    }
    try {
        $decoded = [Convert]::FromBase64String($content)
    } catch {
        throw "Invalid base64. Paste the full tauri-signing.key content."
    }
    if ($decoded.Length -eq 0) {
        throw "Base64 decodes to empty bytes. Key may be truncated."
    }
    return $decoded.Length
}

function Prepare-KeyFromSecret([string]$SecretPath, [string]$OutPath) {
    $raw = Get-Content -LiteralPath $SecretPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "Secret file is empty"
    }

    $trimmed = $raw.Trim()
    if ($trimmed -match "untrusted comment:") {
        Write-Host "    Detected minisign plaintext, converting to base64..." -ForegroundColor Yellow
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
        $b64 = [Convert]::ToBase64String($bytes)
        Set-Content -LiteralPath $OutPath -Value $b64 -NoNewline -Encoding ascii
    } else {
        $singleLine = ($trimmed -replace "`r`n", "" -replace "`n", "")
        Set-Content -LiteralPath $OutPath -Value $singleLine -NoNewline -Encoding ascii
    }

    $byteCount = Test-Base64File $OutPath
    Write-Ok "Secret base64 valid ($byteCount decoded bytes)"
}

function Test-PubkeyMatch([string]$KeyFilePath) {
    if (-not (Test-Path -LiteralPath $TauriConf)) {
        Write-Host "    Skip: tauri.conf.json not found" -ForegroundColor Yellow
        return
    }

    $conf = Get-Content -LiteralPath $TauriConf -Raw | ConvertFrom-Json
    $confPub = $conf.plugins.updater.pubkey
    if ([string]::IsNullOrWhiteSpace($confPub)) {
        Write-Host "    Skip: updater.pubkey not set" -ForegroundColor Yellow
        return
    }

    $pubPath = [System.IO.Path]::ChangeExtension($KeyFilePath, ".pub")
    if (-not (Test-Path -LiteralPath $pubPath)) {
        if (Test-Path -LiteralPath $DefaultPubPath) {
            $pubPath = $DefaultPubPath
        } else {
            Write-Host "    Skip: public key file not found" -ForegroundColor Yellow
            return
        }
    }

    $filePub = (Get-Content -LiteralPath $pubPath -Raw).Trim()
    if ($filePub -eq $confPub.Trim()) {
        Write-Ok "pubkey matches tauri.conf.json"
    } else {
        throw "pubkey mismatch. Update plugins.updater.pubkey in tauri.conf.json"
    }
}

Write-Host "OmniPanel signing key validation" -ForegroundColor White

$tempKeyFile = $null
$resolvedKeyPath = $KeyPath

try {
    Write-Step "1/3 Prepare private key"

    if ($SecretFile) {
        if (-not (Test-Path -LiteralPath $SecretFile)) {
            throw "Secret file not found: $SecretFile"
        }
        $tempKeyFile = Join-Path $env:TEMP ("omnipanel-signing-key-" + [guid]::NewGuid().ToString("n") + ".key")
        Prepare-KeyFromSecret -SecretPath $SecretFile -OutPath $tempKeyFile
        $resolvedKeyPath = $tempKeyFile
        Write-Ok "Prepared temp key from secret file"
    } elseif ($resolvedKeyPath) {
        if (-not (Test-Path -LiteralPath $resolvedKeyPath)) {
            throw "Key file not found: $resolvedKeyPath"
        }
        $byteCount = Test-Base64File $resolvedKeyPath
        Write-Ok "Key file valid ($byteCount decoded bytes): $resolvedKeyPath"
    } elseif ($env:TAURI_SIGNING_PRIVATE_KEY -and (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY)) {
        $resolvedKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY
        $byteCount = Test-Base64File $resolvedKeyPath
        Write-Ok "Using TAURI_SIGNING_PRIVATE_KEY ($byteCount decoded bytes)"
    } elseif (Test-Path -LiteralPath $DefaultKeyPath) {
        $resolvedKeyPath = $DefaultKeyPath
        $byteCount = Test-Base64File $resolvedKeyPath
        Write-Ok "Using default key ($byteCount decoded bytes): $DefaultKeyPath"
    } else {
        throw "No signing key found. Generate one: cd frontend; npm run tauri -- signer generate -w tauri-signing.key --ci"
    }

    Write-Step "2/3 Check pubkey"
    Test-PubkeyMatch -KeyFilePath $resolvedKeyPath

    Write-Step "3/3 Trial sign (same as CI build)"

    if ($PSBoundParameters.ContainsKey("Password")) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $Password
    } elseif (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    }

    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $resolvedKeyPath

    $probe = Join-Path $env:TEMP ("omnipanel-sign-probe-" + [guid]::NewGuid().ToString("n") + ".txt")
    Set-Content -LiteralPath $probe -Value "omnipanel-signing-probe" -NoNewline -Encoding ascii

    Push-Location $FrontendDir
    try {
        npm run tauri -- signer sign -f $resolvedKeyPath $probe
        if ($LASTEXITCODE -ne 0) {
            throw "tauri signer sign failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    $sigFile = "$probe.sig"
    if (-not (Test-Path -LiteralPath $sigFile)) {
        throw "Signature file not created: $sigFile"
    }

    Write-Ok "Trial sign succeeded: $sigFile"

    Write-Host ""
    Write-Host "All checks passed. GitHub Secrets:" -ForegroundColor Green
    Write-Host "  UPDATER_PRIVATE_KEY          = full tauri-signing.key (single-line base64)"
    Write-Host "  UPDATER_PRIVATE_KEY_PASSWORD = empty for no-password keys"
    Write-Host ""
    exit 0
} catch {
    Write-Fail $_.Exception.Message
    Write-Host ""
    Write-Host "Common causes:" -ForegroundColor Yellow
    Write-Host "  - UPDATER_PRIVATE_KEY_PASSWORD set but key has no password"
    Write-Host "  - Secret truncated or contains extra whitespace"
    Write-Host "  - Private key does not match tauri.conf.json pubkey"
    Write-Host "  - Broken empty-password key from Tauri 2.9.3-2.10.0, regenerate"
    Write-Host ""
    exit 1
} finally {
    if ($tempKeyFile -and (Test-Path -LiteralPath $tempKeyFile)) {
        Remove-Item -LiteralPath $tempKeyFile -Force -ErrorAction SilentlyContinue
    }
}

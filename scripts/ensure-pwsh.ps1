# scripts/ensure-pwsh.ps1 - Bundled pwsh 7 bootstrap (invoked explicitly by setup.bat only).
# The MCP server runtime never downloads; only this bootstrap may use the network.
# Fixed artifact + SHA256 + in-repo staging + atomic swap; on failure nothing is left behind
# and an existing valid tools/pwsh stays untouched.
# NOTE: keep this file ASCII-only - Windows PowerShell 5.1 misparses BOM-less UTF-8 comments.
param(
    [string]$Version = '7.6.5',
    [string]$Sha256 = '32EB8F6CDCE08F86E987D625A2733E54AC3E289AE7E1621B14C0B5BCEC2434EA'
)
$ErrorActionPreference = 'Stop'

$root        = Split-Path -Parent $PSScriptRoot
$toolsDir    = Join-Path $root 'tools'
$installDir  = Join-Path $toolsDir 'pwsh'
$staging     = Join-Path $toolsDir '.pwsh-staging'
$versionFile = Join-Path $installDir '.version'
$targetExe   = Join-Path $installDir 'pwsh.exe'

function Probe-Pwsh([string]$Exe) {
    try { return (& $Exe -NoProfile -NoLogo -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()' 2>$null) } catch { return $null }
}

# --- Idempotent: same valid version already installed -> skip (no download, no change) ---
if ((Test-Path $versionFile) -and ((Get-Content $versionFile -Raw).Trim() -eq $Version) -and (Test-Path $targetExe)) {
    $current = Probe-Pwsh $targetExe
    if ($current -and $current.Trim() -eq $Version) {
        Write-Host "[ensure-pwsh] bundled pwsh $Version already installed - skip."
        exit 0
    }
}

# --- Fresh staging (clears any leftover from a previous failed run) ---
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
    # 1) Download the fixed artifact (never a latest URL)
    $url = "https://github.com/PowerShell/PowerShell/releases/download/v$Version/PowerShell-$Version-win-x64.zip"
    $zip = Join-Path $staging "PowerShell-$Version-win-x64.zip"
    Write-Host "[ensure-pwsh] downloading $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    # 2) SHA256 check (mismatch = failure; staging cleaned later; tools/pwsh untouched)
    $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
    if ($actual -ne $Sha256) {
        throw "SHA256 mismatch: expected $Sha256, got $actual"
    }
    Write-Host "[ensure-pwsh] SHA256 verified."

    # 3) Extract inside staging
    $extractDir = Join-Path $staging 'extract'
    Expand-Archive -Path $zip -DestinationPath $extractDir -Force
    $stagedExe = Join-Path $extractDir 'pwsh.exe'
    if (-not (Test-Path $stagedExe)) { throw 'pwsh.exe not found in archive' }

    # 4) Version probe in staging: must be 7.x
    $probe = Probe-Pwsh $stagedExe
    if (-not $probe) { throw 'version probe failed on staged pwsh.exe' }
    $probeVer = $probe.Trim()
    if ($probeVer -notmatch '^7\.') { throw "staged pwsh is not 7.x (got $probeVer)" }
    Write-Host "[ensure-pwsh] staged pwsh probed: $probeVer"

    # 5) Atomic swap: move old dir aside, move staged in; roll back on failure
    $backup = $null
    if (Test-Path $installDir) {
        $backup = Join-Path $toolsDir '.pwsh-old'
        if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
        Move-Item $installDir $backup
    }
    try {
        Move-Item $extractDir $installDir
    } catch {
        if ($backup) { Move-Item $backup $installDir }
        throw
    }
    Set-Content -Path $versionFile -Value $Version -NoNewline
    if ($backup) { Remove-Item -Recurse -Force $backup }

    # 6) Clean staging and the downloaded zip
    Remove-Item -Recurse -Force $staging
    Write-Host "[ensure-pwsh] installed bundled pwsh $probeVer -> $installDir"
    exit 0
}
catch {
    Write-Host "[ensure-pwsh] FAILED: $_"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue }
    Write-Host "[ensure-pwsh] staging cleaned; existing tools\pwsh (if any) left untouched."
    exit 1
}

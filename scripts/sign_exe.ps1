# Optional Authenticode signing for release binaries.
# Enabled when SCRIPTCRAFT_SIGN_THUMBPRINT is set to a code-signing certificate thumbprint
# in the CurrentUser or LocalMachine "My" store. Without it, callers keep building unsigned.
# Usage: . .\scripts\sign_exe.ps1; Sign-ScriptCraftExe -Path path\to\file.exe
function Sign-ScriptCraftExe {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "Signing skipped: file not found: $Path" -ForegroundColor Yellow
        return
    }
    $thumb = ($env:SCRIPTCRAFT_SIGN_THUMBPRINT -replace '\s', '').ToUpperInvariant()
    if (-not $thumb) {
        Write-Host "Code signing skipped for $(Split-Path $Path -Leaf) (set SCRIPTCRAFT_SIGN_THUMBPRINT to enable)" -ForegroundColor DarkGray
        return
    }

    $signtool = $null
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (Test-Path $kits) {
        $signtool = Get-ChildItem -Path $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $signtool) {
        $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
        if ($cmd) { $signtool = $cmd.Source }
    }
    if (-not $signtool) {
        throw "signtool.exe not found (install Windows SDK) but SCRIPTCRAFT_SIGN_THUMBPRINT is set"
    }

    $timestamp = if ($env:SCRIPTCRAFT_SIGN_TIMESTAMP) { $env:SCRIPTCRAFT_SIGN_TIMESTAMP } else { "http://timestamp.digicert.com" }
    Write-Host "Signing $(Split-Path $Path -Leaf) with thumbprint $thumb ..." -ForegroundColor Cyan
    & $signtool sign /sha1 $thumb /fd SHA256 /td SHA256 /tr $timestamp /v $Path
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for $Path (exit $LASTEXITCODE)" }
    Write-Host "Signed: $Path" -ForegroundColor Green
}

# "Clean PC" check of a release: installs ScriptCraftStudio-Setup.exe into a folder with spaces and Cyrillic letters,
# starts the studio the way the launcher does but with a bare environment (no Python, Node.js or Git on PATH,
# no PYTHONPATH...), runs the smoke tests (tests\smoke) against it, then uninstalls.
# Nothing touches the real install: registry entry under HKCU\Software\ScriptCraftStudioCleanCheck, no shortcuts.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\clean_pc_check.ps1 [-Setup portable\ScriptCraftStudio-Setup.exe] [-Keep]
param([string]$Setup = "", [int]$Port = 3456, [switch]$Keep)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Setup) { $Setup = Join-Path $Root "portable\ScriptCraftStudio-Setup.exe" }
if (-not (Test-Path $Setup)) { throw "No installer: $Setup (run make_installer.ps1)" }

$Base = Join-Path $env:TEMP "sc-clean-check"
$App = Join-Path $Base "Мои программы\ScriptCraft Studio"
$RegKey = "Software\ScriptCraftStudioCleanCheck"
function Step($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }

if (Test-Path $Base) { Remove-Item $Base -Recurse -Force }
New-Item -ItemType Directory -Force $Base | Out-Null

Step "Installing into $App"
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $Setup -ArgumentList "/S", "/D=`"$App`"", "/regkey=$RegKey", "/noshortcuts" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Installer failed ($($p.ExitCode)), see $env:TEMP\ScriptCraftSetup.log" }
Write-Host "installed in $([math]::Round($sw.Elapsed.TotalSeconds))s"

Step "Starting the studio with a clean environment on port $Port"
# Only Windows itself on PATH; nothing from the developer's Python / Node / Git
$clean = @{}
foreach ($k in @("SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME", "APPDATA",
                 "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "PUBLIC", "HOMEDRIVE", "HOMEPATH",
                 "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "COMPUTERNAME")) {
    $v = [Environment]::GetEnvironmentVariable($k)
    if ($v) { $clean[$k] = $v }
}
$clean["PATH"] = "$env:windir\System32;$env:windir;$env:windir\System32\Wbem;$env:windir\System32\WindowsPowerShell\v1.0"
$clean["PORT"] = "$Port"
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = "$env:windir\System32\cmd.exe"
$psi.Arguments = "/c `"`"$App\start_studio.bat`" nobrowser < nul > `"$Base\server.log`" 2>&1`""
$psi.WorkingDirectory = $App
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables.Clear()
foreach ($k in $clean.Keys) { $psi.EnvironmentVariables[$k] = $clean[$k] }
$server = [Diagnostics.Process]::Start($psi)

$ok = $false
$sw.Restart()
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).status -eq "ok") { $ok = $true; break } } catch { }
    if ($server.HasExited) { break }
}
if (-not $ok) {
    Get-Content "$Base\server.log" -ErrorAction SilentlyContinue | Select-Object -Last 30
    throw "The studio did not start (see $Base\server.log)"
}
Write-Host "started in $([math]::Round($sw.Elapsed.TotalSeconds))s"

$failed = $false
try {
    Step "Smoke tests"
    Push-Location $Root
    $env:SMOKE_URL = "http://127.0.0.1:$Port"
    npx playwright test --config tests/smoke/playwright.config.ts
    if ($LASTEXITCODE -ne 0) { $failed = $true }
    Pop-Location
} finally {
    Step "Stopping"
    & taskkill /PID $server.Id /T /F | Out-Null
    Start-Sleep -Seconds 1
    if (-not $Keep) {
        Step "Uninstalling"
        Start-Process "$App\Uninstall.exe" -ArgumentList "/S", "/deletedata", "/regkey=$RegKey" -Wait
        for ($i = 0; $i -lt 60 -and (Test-Path $App); $i++) { Start-Sleep -Milliseconds 500 }
        if (Test-Path $App) { Write-Host "[WARN] install folder still exists: $App" -ForegroundColor Yellow; $failed = $true }
        if (Test-Path "HKCU:\$RegKey") { Write-Host "[WARN] registry entry left: HKCU\$RegKey" -ForegroundColor Yellow; $failed = $true }
    }
}
if ($failed) { Write-Host "`n[FAILED] clean PC check" -ForegroundColor Red; exit 1 }
Write-Host "`n[SUCCESS] clean PC check passed" -ForegroundColor Green

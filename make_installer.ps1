# Builds portable\ScriptCraftStudio-Setup.exe: the installer (installer\Setup.cs) with the portable ZIP inside,
# plus ScriptCraftStudio-Setup.exe.sha256 for the studio's auto-update.
# Usage: powershell -ExecutionPolicy Bypass -File make_installer.ps1 [-SkipPortable]
#   -SkipPortable  reuse portable\ScriptCraftStudio-portable.zip instead of building it again
param([switch]$SkipPortable, [string]$Zip = "", [string]$Out = "")
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not $Zip) { $Zip = Join-Path $Root "portable\ScriptCraftStudio-portable.zip" }
if (-not $Out) { $Out = Join-Path $Root "portable\ScriptCraftStudio-Setup.exe" }
if (-not $SkipPortable -and -not $PSBoundParameters.ContainsKey('Zip')) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "make_portable.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Portable build failed" }
}
if (-not (Test-Path $Zip)) { throw "No portable ZIP: $Zip (run make_portable.ps1)" }

$version = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
Write-Host "Installer for version $version" -ForegroundColor Cyan

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) not found" }

$src = Join-Path $env:TEMP "ScriptCraftSetup-$PID.cs"
$stub = Join-Path $env:TEMP "ScriptCraftSetup-$PID.exe"
(Get-Content (Join-Path $Root "installer\Setup.cs") -Raw -Encoding utf8).Replace("__VERSION__", $version) |
    ForEach-Object { [System.IO.File]::WriteAllText($src, $_, (New-Object System.Text.UTF8Encoding($true))) }
$fw = Split-Path $csc
$cscArgs = @("/nologo", "/target:winexe", "/optimize+", "/codepage:65001", "/out:$stub",
             "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
             "/reference:$fw\System.IO.Compression.dll", "/reference:$fw\System.IO.Compression.FileSystem.dll")
$icon = Join-Path $Root "app.ico"
if (Test-Path $icon) { $cscArgs += "/win32icon:$icon" }
$cscArgs += $src
& $csc @cscArgs
$code = $LASTEXITCODE
Remove-Item $src -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "Compiling the installer failed" }

# stub + ZIP + trailer (ZIP length as Int64, "SCSETUP1")
$outStream = [System.IO.File]::Create($Out)
try {
    foreach ($part in @($stub, $Zip)) {
        $in = [System.IO.File]::OpenRead($part)
        try { $in.CopyTo($outStream) } finally { $in.Dispose() }
    }
    $len = (Get-Item $Zip).Length
    $trailer = [BitConverter]::GetBytes([Int64]$len) + [System.Text.Encoding]::ASCII.GetBytes("SCSETUP1")
    $outStream.Write($trailer, 0, $trailer.Length)
} finally { $outStream.Dispose() }
Remove-Item $stub -ErrorAction SilentlyContinue

# Optional Authenticode signature (SCRIPTCRAFT_SIGN_THUMBPRINT). SHA-256 digest is computed after signing.
. (Join-Path $Root "scripts\sign_exe.ps1")
Sign-ScriptCraftExe -Path $Out

$hash = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$Out.sha256" -Value "$hash  $(Split-Path $Out -Leaf)" -Encoding ascii -NoNewline
$mb = [math]::Round((Get-Item $Out).Length / 1MB, 1)
Write-Host "[SUCCESS] $Out ($mb MB)" -ForegroundColor Green
Write-Host "SHA-256: $hash" -ForegroundColor Green

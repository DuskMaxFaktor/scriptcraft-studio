# Builds a portable ScriptCraft Studio: a folder (and a ZIP) that runs on a Windows PC without Node.js or Python installed.
# Usage: powershell -ExecutionPolicy Bypass -File make_portable.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$NodeVersion = "v22.22.2"
$NodeZipName = "node-$NodeVersion-win-x64.zip"
$PythonVersion = "3.14.8"
$PythonZipName = "python-$PythonVersion-embed-amd64.zip"
$CacheDir = Join-Path $Root "build-cache"
$OutParent = Join-Path $Root "portable"
$Out = Join-Path $OutParent "ScriptCraftStudio"
$ZipPath = Join-Path $OutParent "ScriptCraftStudio-portable.zip"

function Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }

# 1. Fresh UI build
Step "Building the UI"
npm run build
if ($LASTEXITCODE -ne 0) { throw "UI build failed" }

# 2. Official Node.js for Windows (cached; checksum verified against nodejs.org SHASUMS256.txt)
Step "Getting Node.js $NodeVersion"
New-Item -ItemType Directory -Force $CacheDir | Out-Null
$NodeZip = Join-Path $CacheDir $NodeZipName
$Sums = Join-Path $CacheDir "SHASUMS256-$NodeVersion.txt"
if (-not (Test-Path $Sums)) { Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -OutFile $Sums -UseBasicParsing }
if (-not (Test-Path $NodeZip)) { Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$NodeZipName" -OutFile $NodeZip -UseBasicParsing }
$expected = ((Select-String -Path $Sums -Pattern ([regex]::Escape($NodeZipName))).Line -split '\s+')[0]
$actual = (Get-FileHash $NodeZip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { Remove-Item $NodeZip; throw "Node.js archive checksum mismatch - deleted, run again" }
Write-Host "checksum OK"

# 3. Copy the studio (never the user's projects, keys, settings or logs)
Step "Copying files to $Out"
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force $Out | Out-Null
$items = @("api", "dist", "electron", "public", "scripts", "src", "tests", "server.ts", "index.html", "vite.config.ts", "tsconfig.json",
           "package.json", "package-lock.json", "metadata.json", "start_studio.bat", "run_studio.vbs", "create_desktop_shortcut.bat",
           "diagnostics.bat", "run_script.bat", "build_exe.ps1", "build_exe.bat", "make_icon.py", "app.ico", "ScriptCraftStudio.exe", ".env.example", ".gitignore")
foreach ($item in $items) {
    if (Test-Path $item) { Copy-Item $item -Destination $Out -Recurse -Force }
}
# Empty key template instead of the real .env
Copy-Item ".env.example" (Join-Path $Out ".env") -Force

# 4. Only the server's dependencies (the UI is already built)
Step "Copying node_modules and removing build-only packages"
robocopy (Join-Path $Root "node_modules") (Join-Path $Out "node_modules") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying node_modules failed" }
Push-Location $Out
npm prune --omit=dev --legacy-peer-deps --no-audit --no-fund
$pruneCode = $LASTEXITCODE
Pop-Location
if ($pruneCode -ne 0) { throw "npm prune failed" }
# Studio window (Electron): keep only the Russian and English UI locales of Chromium
$locales = Join-Path $Out "node_modules\electron\dist\locales"
if (Test-Path $locales) { Get-ChildItem $locales -Filter *.pak | Where-Object { $_.Name -notin @("ru.pak", "en-US.pak") } | Remove-Item -Force }

# 5. Bundled Node.js -> runtime\node
Step "Adding Node.js runtime"
$tmpExtract = Join-Path $CacheDir "extract"
if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
Expand-Archive $NodeZip -DestinationPath $tmpExtract
New-Item -ItemType Directory -Force (Join-Path $Out "runtime") | Out-Null
Move-Item (Join-Path $tmpExtract "node-$NodeVersion-win-x64") (Join-Path $Out "runtime\node")
Remove-Item $tmpExtract -Recurse -Force

# 6. Bundled Python (official "embeddable" package) -> runtime\python, with pip
Step "Adding Python $PythonVersion runtime"
$PyZip = Join-Path $CacheDir $PythonZipName
if (-not (Test-Path $PyZip)) { Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/$PythonZipName" -OutFile $PyZip -UseBasicParsing }
# Official SHA-256 from the python.org downloads API
$release = (Invoke-RestMethod "https://www.python.org/api/v2/downloads/release/?name=Python%20$PythonVersion")[0]
$releaseId = ($release.resource_uri -split '/')[-2]
$pyExpected = ((Invoke-RestMethod "https://www.python.org/api/v2/downloads/release_file/?release=$releaseId") | Where-Object { $_.url -like "*/$PythonZipName" }).sha256_sum
$pyActual = (Get-FileHash $PyZip -Algorithm SHA256).Hash.ToLower()
if (-not $pyExpected -or $pyExpected -ne $pyActual) { Remove-Item $PyZip; throw "Python archive checksum mismatch - deleted, run again" }
Write-Host "checksum OK"
$PyDir = Join-Path $Out "runtime\python"
Expand-Archive $PyZip -DestinationPath $PyDir
# Keep the isolation of the ._pth file (never use another Python's library from the registry), enable site-packages
$pthFile = Get-ChildItem $PyDir -Filter "python*._pth" | Select-Object -First 1
$zipName = (Get-ChildItem $PyDir -Filter "python3*.zip" | Select-Object -First 1).Name
Set-Content -Path $pthFile.FullName -Value "$zipName`n.`nLib\site-packages`nimport site" -Encoding ascii
New-Item -ItemType Directory -Force (Join-Path $PyDir "Lib\site-packages") | Out-Null
# Script folder + PYTHONPATH on sys.path (see scripts\portable\README.md)
Copy-Item (Join-Path $Root "scripts\portable\scriptcraft_paths.pth") (Join-Path $PyDir "Lib\site-packages\scriptcraft_paths.pth")
$GetPip = Join-Path $CacheDir "get-pip.py"
if (-not (Test-Path $GetPip)) { Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPip -UseBasicParsing }
& (Join-Path $PyDir "python.exe") $GetPip --no-warn-script-location --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw "Installing pip into the bundled Python failed" }
# Ruff (formatter and checks), Jedi (Python hints), pytest (the "Tests" tab), PyInstaller ("Build .exe"),
# and pefile + capstone (the "Disassembler": inspect/patch .exe files); the studio finds them in runtime\python
& (Join-Path $PyDir "python.exe") -m pip install ruff jedi pytest pyinstaller pefile capstone --no-warn-script-location --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw "Installing Ruff, Jedi, pytest, PyInstaller, pefile and capstone into the bundled Python failed" }

# 7. Portable marker + readme
Set-Content -Path (Join-Path $Out ".portable-build") -Value "Portable build $(Get-Date -Format s)" -Encoding ascii
$readme = @"
ScriptCraft Studio - портативная версия

1. Распакуйте архив в любую папку (лучше без кириллицы и пробелов в пути).
2. Запустите ScriptCraftStudio.exe. Ничего устанавливать не нужно: Node.js лежит в runtime\node,
   Python $PythonVersion (с pip) - в runtime\python.
3. Ключ Gemini: кнопка с чипом в шапке студии -> "Нейросети".

Во встроенном Python нет модулей tkinter и venv (так устроен официальный "embeddable" Python).
Ваши проекты хранятся в папке projects рядом со студией.
"@
Set-Content -Path (Join-Path $Out "README-PORTABLE.txt") -Value $readme -Encoding utf8

# 8. ZIP
Step "Creating ZIP"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Push-Location $OutParent
# System bsdtar (not a tar from Git Bash that may be first on PATH)
& (Join-Path $env:WINDIR "System32\tar.exe") -a -c -f $ZipPath "ScriptCraftStudio"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Creating ZIP failed" }
Pop-Location

$folderMB = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
$zipMB = [math]::Round(((Get-Item $ZipPath).Length / 1MB), 1)
Write-Host "`n[SUCCESS] Portable folder: $Out ($folderMB MB)" -ForegroundColor Green
Write-Host "[SUCCESS] ZIP: $ZipPath ($zipMB MB)" -ForegroundColor Green

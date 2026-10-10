@echo off
setlocal
cd /d "%~dp0"
title ScriptCraft Studio - Launcher

echo ==============================================================================
echo                      ScriptCraft Studio - Launcher
echo ==============================================================================
echo.

:: 0. Portable version: use the bundled Node.js (runtime\node) if present
if exist "%~dp0runtime\node\node.exe" set "PATH=%~dp0runtime\node;%PATH%"
if exist "%~dp0runtime\python\python.exe" set "PATH=%~dp0runtime\python;%~dp0runtime\python\Scripts;%PATH%"

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed on this PC!
    echo Please download and install Node.js from https://nodejs.org
    echo After installing, restart this file.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js is ready:
node -v
echo.

:: 2. Check package.json
if not exist "package.json" (
    echo [ERROR] package.json not found in this folder!
    echo Make sure you extracted the full zip archive.
    echo.
    pause
    exit /b 1
)

:: 3. Setup .env
if not exist ".env" (
    if exist ".env.example" copy ".env.example" ".env" >nul
)

:: 4. Check dependencies (specifically vite; the portable build ships only the server's packages)
if exist ".portable-build" goto :deps_ok
if not exist "node_modules\vite\" (
    echo [INFO] Installing required packages - npm install...
    echo This may take 1-2 minutes on first run, please wait...
    echo.
    call npm install --legacy-peer-deps
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] npm install failed. Please check internet connection.
        pause
        exit /b 1
    )
    echo [OK] Installation complete!
    echo.
)
:deps_ok

:: 5. Open browser (skipped when launched from ScriptCraftStudio.exe, which opens its own window)
if /i not "%~1"=="nobrowser" (
    echo [INFO] Opening browser at http://localhost:3000...
    start "" http://localhost:3000
)

:: 6. Launch the studio server
echo ==============================================================================
echo Studio is starting! Keep this window OPEN while using the studio.
echo Press Ctrl + C to stop the server.
echo ==============================================================================
echo.

:: "dev" argument = Vite dev server with hot reload (for editing the studio itself);
:: otherwise the fast production server (builds the UI only after updates)
if /i "%~1"=="dev" goto :dev
if /i "%~2"=="dev" goto :dev
node scripts\launch.mjs
goto :end

:dev
call npm run dev

:end

pause

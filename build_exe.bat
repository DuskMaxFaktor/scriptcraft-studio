@echo off
setlocal
cd /d "%~dp0"
title ScriptCraft Studio - EXE Generator

echo ==============================================================================
echo                ScriptCraft Studio - EXE Generator
echo ==============================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_exe.ps1"

if exist "ScriptCraftStudio.exe" (
    echo.
    echo ScriptCraftStudio.exe is ready!
) else (
    echo.
    echo Compilation failed. Checking fallback...
)

echo.
pause

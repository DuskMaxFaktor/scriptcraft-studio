@echo off
setlocal
cd /d "%~dp0"

title Run Script on PC

echo ==============================================================================
echo                Script Runner for Windows
echo ==============================================================================
echo.

:: Check for python script in current directory
set TARGET=
if exist "analytics.py" set TARGET=analytics.py
if exist "script.py" set TARGET=script.py
if exist "main.py" set TARGET=main.py

if "%TARGET%"=="" (
    for %%F in (*.py) do (
        set TARGET=%%F
        goto :found_py
    )
)

:found_py
if not "%TARGET%"=="" (
    echo [INFO] Found Python script: %TARGET%
    echo [INFO] Executing with Python...
    echo ------------------------------------------------------------------------------
    python "%TARGET%"
    if %errorlevel% neq 0 (
        py -3 "%TARGET%"
    )
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] Python is not installed or not in PATH!
        echo Download Python from: https://python.org
    )
    echo ------------------------------------------------------------------------------
    echo.
    pause
    exit /b 0
)

:: Check for javascript script
if exist "script.js" (
    echo [INFO] Found JavaScript script: script.js
    echo [INFO] Executing with Node.js...
    echo ------------------------------------------------------------------------------
    node script.js
    echo ------------------------------------------------------------------------------
    echo.
    pause
    exit /b 0
)

echo [ERROR] No .py or .js script found in this folder.
echo Put this .bat file in the same folder as your script and run it again.
echo.
pause

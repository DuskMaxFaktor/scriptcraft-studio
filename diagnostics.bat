@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
color 0F
title ScriptCraft Studio - Diagnostic Assistant

echo ==============================================================================
echo              ScriptCraft Studio - Проверка системы и диагностика
echo ==============================================================================
echo.

:: 1. Проверка запуска из архива (Temp folder)
echo [1/4] Проверка папки запуска...
echo Текущая папка: %~dp0
echo %~dp0 | findstr /i "Temp" >nul
if %errorlevel% equ 0 (
    echo [ВНИМАНИЕ] Похоже, вы запустили файл прямо из архива ZIP без распаковки!
    echo Решение: Сначала нажмите правой кнопкой мыши по архиву -> "Извлечь все...",
    echo затем перейдите в извлеченную папку и запустите файл оттуда.
    echo.
) else (
    echo [OK] Запущено из обычной папки.
)
echo.

:: 2. Проверка Node.js
echo [2/4] Проверка Node.js...
where node >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
    echo [OK] Node.js найден: !NODE_VER!
) else (
    echo [НЕТ] Node.js НЕ установлен в системе!
    echo Для локального запуска студии требуется Node.js.
    echo Скачайте и установите: https://nodejs.org/ ^(версия LTS^)
)
echo.

:: 3. Проверка Python
echo [3/4] Проверка Python...
where python >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%p in ('python --version 2^>^&1') do set PY_VER=%%p
    echo [OK] Python найден: !PY_VER!
) else (
    where py >nul 2>nul
    if !errorlevel! equ 0 (
        for /f "tokens=*" %%p in ('py --version 2^>^&1') do set PY_VER=%%p
        echo [OK] Python лаунчер найден: !PY_VER!
    ) else (
        echo [НЕТ] Python не найден в системе ^(PATH^).
        echo Скачать Python: https://python.org
    )
)
echo.

:: 4. Проверка файлов проекта
echo [4/4] Проверка файлов проекта...
if exist "package.json" (
    echo [OK] package.json найден.
) else (
    echo [ИНФО] package.json отсутствует в этой папке ^(это папка только для скриптов^).
)

if exist "analytics.py" echo [OK] Найден скрипт analytics.py
if exist "script.js" echo [OK] Найден скрипт script.js
echo.

echo ==============================================================================
echo ДИАГНОСТИКА ЗАВЕРШЕНА.
echo Скопируйте или сфотографируйте то, что написано выше, если нужна помощь.
echo ==============================================================================
echo.
pause

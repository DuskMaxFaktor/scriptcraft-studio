@echo off
setlocal
cd /d "%~dp0"
title ScriptCraft Studio - Desktop Shortcut

set "VBS=%temp%\create_sc_%random%.vbs"

echo Set oWS = CreateObject("WScript.Shell") > "%VBS%"
echo sDesktop = oWS.SpecialFolders("Desktop") >> "%VBS%"
echo Set oLink = oWS.CreateShortcut(sDesktop ^& "\ScriptCraft Studio.lnk") >> "%VBS%"
echo oLink.TargetPath = "%~dp0start_studio.bat" >> "%VBS%"
echo oLink.WorkingDirectory = "%~dp0" >> "%VBS%"
echo oLink.Save >> "%VBS%"

cscript //nologo "%VBS%"
if exist "%VBS%" del "%VBS%" >nul 2>nul

echo Shortcut created on your Desktop!
pause
@echo off
setlocal
chcp 65001 >nul
title CodeX Provider Switcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Apply
set "exit_code=%ERRORLEVEL%"
echo.
if not "%exit_code%"=="0" (
    echo CodeX Provider Switcher did not start. Exit code: %exit_code%
) else (
    echo CodeX Provider Switcher startup flow completed.
)
pause
exit /b %exit_code%

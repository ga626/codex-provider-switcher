@echo off
setlocal
chcp 65001 >nul
title CodeX Provider Switcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Apply
set "exit_code=%ERRORLEVEL%"
echo.
if not "%exit_code%"=="0" (
    echo CodeX Provider Switcher 启动失败。退出码：%exit_code%
) else (
    echo CodeX Provider Switcher 启动流程已完成。
)
pause
exit /b %exit_code%

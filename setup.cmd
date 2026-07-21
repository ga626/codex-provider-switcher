@echo off
setlocal
chcp 65001 >nul
title Signalman AI
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Apply
set "exit_code=%ERRORLEVEL%"
echo.
if not "%exit_code%"=="0" (
    echo Signalman AI 启动失败。退出码：%exit_code%
) else (
    echo Signalman AI 启动流程已完成。
)
pause
exit /b %exit_code%

@echo off
setlocal
chcp 65001 >nul
title Signalman AI
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0SignalmanAI.ps1" %*
exit /b %ERRORLEVEL%

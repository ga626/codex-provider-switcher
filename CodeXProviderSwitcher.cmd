@echo off
setlocal
chcp 65001 >nul
title CodeX Provider Switcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0CodeXProviderSwitcher.ps1" %*
exit /b %ERRORLEVEL%

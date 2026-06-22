@echo off
setlocal
cd /d "%~dp0"
title Lotto Weighted Prediction UI
echo Starting Lotto UI at http://localhost:6490
echo.
node .\lottery_ui_server.mjs
echo.
echo UI server stopped. Press any key to close this window.
pause >nul

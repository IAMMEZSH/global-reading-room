@echo off
setlocal
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0server.js" %*
echo.
echo The server has stopped. Press any key to close this window.
pause >nul

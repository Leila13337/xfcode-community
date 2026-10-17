@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node server.mjs
  pause
  exit /b
)
set "XFCODE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%XFCODE_NODE%" (
  "%XFCODE_NODE%" server.mjs
) else (
  echo 请先安装 Node.js 24 或更新版本，再运行 START.cmd。
)
pause

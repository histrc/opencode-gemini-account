@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1
node scripts\inspect-studio.mjs
popd
pause

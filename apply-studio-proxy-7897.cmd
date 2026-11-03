@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1
node scripts\apply-studio-proxy.mjs http://127.0.0.1:7897
if errorlevel 1 goto report
node scripts\wait-studio-ready.mjs
if errorlevel 1 goto report
:report
if exist scripts\inspect-studio.mjs node scripts\inspect-studio.mjs
popd
pause

@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1
node scripts\wait-studio-ready.mjs
if errorlevel 1 goto report
set "GEMINI_ACCOUNT_VERIFY_MODEL=gemini-3.8-flash"
node scripts\verify-managed.mjs --live
:report
if exist scripts\inspect-studio.mjs node scripts\inspect-studio.mjs
popd
pause

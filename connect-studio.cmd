@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
node scripts\local.mjs connect studio
popd
pause

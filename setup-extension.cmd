@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
node scripts\extension-setup.mjs
if errorlevel 1 goto end
node scripts\local.mjs connect studio --legacy-browser
if errorlevel 1 goto end
node scripts\local.mjs smoke studio --legacy-browser
:end
popd
pause

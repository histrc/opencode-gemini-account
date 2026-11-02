@echo off
setlocal
title OpenCode Gemini Account - Install
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto missing_node

echo Installing runtime dependencies...
call npm.cmd ci --omit=dev --ignore-scripts
if errorlevel 1 goto failed

echo Installing the OpenCode plugin...
node scripts\install.mjs --v2 --managed
if errorlevel 1 goto failed

echo.
echo Installation finished. Keep this extracted folder in its current location.
echo Restart OpenCode, run /connect, and choose AI Studio Account or Gemini Web Account.
echo The plugin downloads and manages both backends automatically. Magpie is not required.
popd
pause
exit /b 0

:missing_node
echo Node.js 22 or newer, including npm, is required.
echo Install Node.js and run this file again.
goto failed

:failed
echo.
echo Installation did not finish. See the error above.
popd
pause
exit /b 1

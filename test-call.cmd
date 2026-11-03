@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1
if "%~1"=="" (
  echo 此可选开发检查需要显式指定型号，例如 test-call.cmd gemini-3.8-flash
  echo 日常可直接在 OpenCode 选择型号使用；本次未发送生成请求。
  goto end
)
set "GEMINI_ACCOUNT_VERIFY_MODEL=%~1"
node scripts\local.mjs smoke studio
:end
popd
pause

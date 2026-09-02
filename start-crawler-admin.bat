@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0backend"

set PORT=5002
set URL=http://127.0.0.1:%PORT%/

echo Starting crawler admin at %URL%
echo Close this window to stop the admin server and crawler.
echo.

rem 延後 2 秒等 server 起來再開瀏覽器 (用 powershell 避開 cmd 引號 nesting 問題)
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"

python -X utf8 -u -m crawler admin --port %PORT%
set EXITCODE=%errorlevel%

echo.
echo Admin server exited with code %EXITCODE%
pause
endlocal

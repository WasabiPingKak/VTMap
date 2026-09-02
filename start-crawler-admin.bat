@echo off
rem Crawler Admin launcher. Keep this file ASCII-only:
rem cmd reads .bat files with the system ANSI codepage (CP950 on this box),
rem so UTF-8 multibyte chars inside a rem line will scramble the parser.
setlocal
cd /d "%~dp0backend"

set PORT=5002
set URL=http://127.0.0.1:%PORT%/

echo Starting crawler admin at %URL%
echo Close this window to stop the admin server and crawler.
echo.

rem Wait 2s then open the browser via powershell (single quotes only).
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"

python -X utf8 -u -m crawler admin --port %PORT%
set EXITCODE=%errorlevel%

echo.
echo Admin server exited with code %EXITCODE%
pause
endlocal

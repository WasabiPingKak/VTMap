@echo off
rem 啟動爬蟲管理台 (本機 UI)
rem 用法:雙擊此檔,或在終端執行 start-crawler-admin.bat
rem 管理台跑在 http://127.0.0.1:5002
rem 關閉此視窗會一併停止爬蟲子程序

setlocal
cd /d "%~dp0backend"

set PORT=5002
set URL=http://127.0.0.1:%PORT%/

rem 延後 1.5 秒開瀏覽器,等 server 起來
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" "%URL%""

python -X utf8 -m crawler admin --port %PORT%

endlocal

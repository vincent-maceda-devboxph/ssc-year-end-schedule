@echo off
rem Starts the tournament server in this window (double-click). Close the window to stop it.
rem Optional: set BACKUP_MIRROR_DIR=E:\badminton-backups  to copy every backup to a USB stick.
cd /d "%~dp0\..\.."
if not defined PORT set PORT=3000
if not exist apps\api\dist\server.js (
  echo The server is not built yet. Run "npm run build" first.
  pause
  exit /b 1
)
node scripts\doctor.mjs
echo.
echo Starting the server. Keep this window open during the tournament.
node apps\api\dist\server.js
echo.
echo The server stopped.
pause

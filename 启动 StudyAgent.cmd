@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or newer is required. Please install Node.js first.
  pause
  exit /b 1
)
if not exist "node_modules\pdfjs-dist" (
  echo Dependencies are missing. Run npm install in this folder first.
  pause
  exit /b 1
)
start "StudyAgent server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173/"
echo StudyAgent opened in your browser. If the page loads before the server, refresh once.

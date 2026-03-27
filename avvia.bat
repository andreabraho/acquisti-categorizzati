@echo off
cd /d "%~dp0"
start "" "http://localhost:3001/acquisti.html"
npx nodemon acquisti-server.js

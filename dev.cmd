@echo off
rem Runs the dev servers using the portable Node.js in .tools\node.
set "PATH=%~dp0.tools\node;%PATH%"
cd /d "%~dp0"
npm run dev

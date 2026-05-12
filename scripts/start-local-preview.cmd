@echo off
setlocal

rem Starts the production Next.js preview server for local browser review.
rem This script is intentionally small so Windows Task Scheduler can run it
rem independently from Codex/tooling sessions.
cd /d "%~dp0.."

node node_modules\next\dist\bin\next start --hostname 127.0.0.1 --port 3010

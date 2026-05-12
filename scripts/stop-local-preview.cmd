@echo off
setlocal

rem Stops any process listening on the local preview port.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3010"') do (
  taskkill /PID %%p /F >nul 2>nul
)

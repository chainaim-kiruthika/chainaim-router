@echo off
rem Switches the local test gateway back to the stand-in model that echoes,
rem and removes the OpenRouter key from the gateway container.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-models.ps1" stub
pause

@echo off
rem Switches the local test gateway to OpenRouter's real free models.
rem It asks for your OpenRouter API key in a hidden prompt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-models.ps1" real
pause

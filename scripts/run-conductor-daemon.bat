@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"

set "CONDUCTOR_CLI=%REPO_ROOT%\cli\bin\conductor.js"
set "CONFIG_FILE=%CONDUCTOR_CONFIG_FILE%"
if not defined CONFIG_FILE set "CONFIG_FILE=%USERPROFILE%\.conductor\config.yaml"
set "WORK_DIR=%REPO_ROOT%\cli"

set "NODE_EXE=%CONDUCTOR_NODE%"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%N"
  )
)
if not defined NODE_EXE (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  )
)

set "FORCE_ARG="
set "RUNNING_PID="
set "PID_FILE="

if not defined NODE_EXE (
  echo Node executable not found. Install Node.js or set CONDUCTOR_NODE.
  pause
  exit /b 1
)

if not exist "%NODE_EXE%" (
  echo Node executable not found:
  echo   %NODE_EXE%
  pause
  exit /b 1
)

if not exist "%CONDUCTOR_CLI%" (
  echo Conductor CLI not found:
  echo   %CONDUCTOR_CLI%
  pause
  exit /b 1
)

if not exist "%CONFIG_FILE%" (
  echo Conductor config not found:
  echo   %CONFIG_FILE%
  pause
  exit /b 1
)

for /f "usebackq delims=" %%F in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$config = '%CONFIG_FILE%'; $workspace = $null; if (Test-Path -LiteralPath $config) { foreach ($line in Get-Content -LiteralPath $config) { if ($line -match '^\s*workspace\s*:\s*(.+?)\s*(?:#.*)?$') { $workspace = $Matches[1].Trim().Trim([char]34, [char]39); break } } }; if (-not $workspace) { $workspace = Join-Path $env:USERPROFILE 'ws' }; if ($workspace -eq '~') { $workspace = $env:USERPROFILE } elseif ($workspace.StartsWith('~/') -or $workspace.StartsWith('~\')) { $workspace = Join-Path $env:USERPROFILE $workspace.Substring(2) }; $workspace = [Environment]::ExpandEnvironmentVariables($workspace); $workspace = [System.IO.Path]::GetFullPath($workspace); Write-Output (Join-Path $workspace 'daemon.pid')"`) do (
  set "PID_FILE=%%F"
)

for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$pidFile = '%PID_FILE%'; if (Test-Path -LiteralPath $pidFile) { $raw = (Get-Content -LiteralPath $pidFile -TotalCount 1 -ErrorAction SilentlyContinue).Trim(); if ($raw -match '^[0-9]+$') { try { $process = Get-Process -Id ([int]$raw) -ErrorAction Stop; if ($process.ProcessName -like 'node*') { Write-Output $raw } } catch {} } }"`) do (
  set "RUNNING_PID=%%P"
)

if defined RUNNING_PID (
  echo A conductor daemon appears to be running with PID !RUNNING_PID!.
  choice /M "Start with --force and replace the running daemon"
  if errorlevel 2 (
    echo Keeping the existing daemon. Nothing started.
    pause
    exit /b 0
  )
  set "FORCE_ARG=--force"
)

echo.
echo Starting conductor daemon...
echo Config: %CONFIG_FILE%
echo Repo: %REPO_ROOT%
if defined FORCE_ARG echo Mode: --force
echo.

cd /d "%WORK_DIR%"
"%NODE_EXE%" "%CONDUCTOR_CLI%" daemon --config-file "%CONFIG_FILE%" %FORCE_ARG%
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Conductor daemon exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

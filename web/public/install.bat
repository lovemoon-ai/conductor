@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Conductor CLI Windows batch installer.
rem Usage:
rem   install.bat
rem   install.bat --package-version 0.7.1
rem   install.bat --force-node-download --no-path-update

set "PACKAGE_NAME=@love-moon/conductor-cli"
set "PACKAGE_VERSION=latest"
set "NODE_VERSION=23.11.0"
set "FORCE_NODE_DOWNLOAD=0"
set "NO_PATH_UPDATE=0"
set "SHOW_HELP=0"

if /I not "%OS%"=="Windows_NT" (
  call :LogError "This installer is intended for Windows."
  exit /b 1
)

if not defined USERPROFILE (
  call :LogError "USERPROFILE is not set."
  exit /b 1
)

set "CONDUCTOR_HOME=%USERPROFILE%\.conductor"

call :ParseArgs %*
if errorlevel 1 exit /b 1
if "%SHOW_HELP%"=="1" exit /b 0

where powershell.exe >nul 2>nul
if errorlevel 1 (
  call :LogError "powershell.exe was not found on PATH."
  exit /b 1
)

call :FindCommand "node" NODE_CMD
call :FindCommand "npm" NPM_CMD
set "NODE_BIN_DIR="

if "%FORCE_NODE_DOWNLOAD%"=="1" goto UseManagedNode
if not defined NODE_CMD goto UseManagedNode
if not defined NPM_CMD goto UseManagedNode
goto UseExistingNode

:UseManagedNode
call :LogWarn "Node.js/npm not found on PATH; installing a managed Node.js runtime."
call :InstallManagedNode "%NODE_VERSION%" "%CONDUCTOR_HOME%\node"
if errorlevel 1 exit /b 1
goto ConfigureNpm

:UseExistingNode
for %%I in ("%NODE_CMD%") do set "NODE_BIN_DIR=%%~dpI"
if defined NODE_BIN_DIR if "!NODE_BIN_DIR:~-1!"=="\" set "NODE_BIN_DIR=!NODE_BIN_DIR:~0,-1!"

:ConfigureNpm
set "NPM_GLOBAL_PREFIX=%CONDUCTOR_HOME%\npm-global"
set "NPM_GLOBAL_BIN=%NPM_GLOBAL_PREFIX%"
if not exist "%NPM_GLOBAL_PREFIX%" mkdir "%NPM_GLOBAL_PREFIX%" >nul 2>nul
if errorlevel 1 (
  call :LogError "Failed to create npm global prefix: %NPM_GLOBAL_PREFIX%"
  exit /b 1
)

call :LogInfo "Using node: %NODE_CMD%"
call :LogInfo "Using npm: %NPM_CMD%"
call :LogInfo "Using npm global prefix: %NPM_GLOBAL_PREFIX%"

call "%NPM_CMD%" config set prefix "%NPM_GLOBAL_PREFIX%"
if errorlevel 1 (
  call :LogError "Failed to configure npm prefix."
  exit /b 1
)

set "PACKAGE_SPEC=%PACKAGE_NAME%@%PACKAGE_VERSION%"
call :LogInfo "Installing %PACKAGE_SPEC%"
call "%NPM_CMD%" install -g "%PACKAGE_SPEC%"
if errorlevel 1 (
  call :LogError "Failed to install %PACKAGE_SPEC%."
  exit /b 1
)

if not "%NO_PATH_UPDATE%"=="1" (
  call :AddUserPathEntry "%NODE_BIN_DIR%"
  call :AddUserPathEntry "%NPM_GLOBAL_BIN%"
  call :LogInfo "Open a new terminal for PATH changes to take effect everywhere."
)

set "CONDUCTOR_CMD=%NPM_GLOBAL_BIN%\conductor.cmd"
if not exist "%CONDUCTOR_CMD%" (
  call :FindCommand "conductor" CONDUCTOR_CMD
)

if not defined CONDUCTOR_CMD (
  call :LogError "Conductor installed, but conductor.cmd was not found."
  exit /b 1
)

call :LogInfo "Verifying Conductor CLI"
call "%CONDUCTOR_CMD%" --version
if errorlevel 1 (
  call :LogError "Conductor CLI verification failed."
  exit /b 1
)

call :LogInfo "Resolved paths:"
call :LogInfo "  node: %NODE_CMD%"
call :LogInfo "  npm: %NPM_CMD%"
call :LogInfo "  conductor: %CONDUCTOR_CMD%"
call :LogInfo "Done."
exit /b 0

:ParseArgs
if "%~1"=="" exit /b 0

if /I "%~1"=="-h" goto PrintUsage
if /I "%~1"=="--help" goto PrintUsage
if /I "%~1"=="/?" goto PrintUsage

if /I "%~1"=="--package-name" (
  if "%~2"=="" goto MissingValue
  set "PACKAGE_NAME=%~2"
  shift
  shift
  goto ParseArgs
)
if /I "%~1"=="-PackageName" (
  if "%~2"=="" goto MissingValue
  set "PACKAGE_NAME=%~2"
  shift
  shift
  goto ParseArgs
)

if /I "%~1"=="--package-version" (
  if "%~2"=="" goto MissingValue
  set "PACKAGE_VERSION=%~2"
  shift
  shift
  goto ParseArgs
)
if /I "%~1"=="-PackageVersion" (
  if "%~2"=="" goto MissingValue
  set "PACKAGE_VERSION=%~2"
  shift
  shift
  goto ParseArgs
)

if /I "%~1"=="--node-version" (
  if "%~2"=="" goto MissingValue
  set "NODE_VERSION=%~2"
  shift
  shift
  goto ParseArgs
)
if /I "%~1"=="-NodeVersion" (
  if "%~2"=="" goto MissingValue
  set "NODE_VERSION=%~2"
  shift
  shift
  goto ParseArgs
)

if /I "%~1"=="--conductor-home" (
  if "%~2"=="" goto MissingValue
  set "CONDUCTOR_HOME=%~2"
  shift
  shift
  goto ParseArgs
)
if /I "%~1"=="-ConductorHome" (
  if "%~2"=="" goto MissingValue
  set "CONDUCTOR_HOME=%~2"
  shift
  shift
  goto ParseArgs
)

if /I "%~1"=="--force-node-download" (
  set "FORCE_NODE_DOWNLOAD=1"
  shift
  goto ParseArgs
)
if /I "%~1"=="-ForceNodeDownload" (
  set "FORCE_NODE_DOWNLOAD=1"
  shift
  goto ParseArgs
)

if /I "%~1"=="--no-path-update" (
  set "NO_PATH_UPDATE=1"
  shift
  goto ParseArgs
)
if /I "%~1"=="-NoPathUpdate" (
  set "NO_PATH_UPDATE=1"
  shift
  goto ParseArgs
)

call :LogError "Unknown argument: %~1"
call :PrintUsage
exit /b 1

:MissingValue
call :LogError "Missing value for argument: %~1"
exit /b 1

:PrintUsage
set "SHOW_HELP=1"
echo.
echo Conductor CLI Windows batch installer
echo.
echo Usage:
echo   install.bat [options]
echo.
echo Options:
echo   --package-name NAME       npm package name. Default: @love-moon/conductor-cli
echo   --package-version VERSION npm package version. Default: latest
echo   --node-version VERSION    managed Node.js version. Default: 23.11.0
echo   --conductor-home PATH     install root. Default: %%USERPROFILE%%\.conductor
echo   --force-node-download     download managed Node.js even when node/npm exist
echo   --no-path-update          do not update the user PATH
echo   --help                    show this help
echo.
exit /b 0

:FindCommand
set "%~2="
set "FIND_COMMAND_NAME=%~1"
set "FIND_COMMAND_RESULT="

for /f "delims=" %%C in ('where "%FIND_COMMAND_NAME%" 2^>nul') do (
  if not defined FIND_COMMAND_RESULT (
    set "FIND_COMMAND_EXT=%%~xC"
    if /I "!FIND_COMMAND_EXT!"==".exe" set "FIND_COMMAND_RESULT=%%~fC"
    if /I "!FIND_COMMAND_EXT!"==".cmd" set "FIND_COMMAND_RESULT=%%~fC"
    if /I "!FIND_COMMAND_EXT!"==".bat" set "FIND_COMMAND_RESULT=%%~fC"
  )
)

if not defined FIND_COMMAND_RESULT (
  for /f "delims=" %%C in ('where "%FIND_COMMAND_NAME%" 2^>nul') do (
    if not defined FIND_COMMAND_RESULT set "FIND_COMMAND_RESULT=%%~fC"
  )
)

if defined FIND_COMMAND_RESULT set "%~2=%FIND_COMMAND_RESULT%"
exit /b 0

:GetNodeArch
set "NODE_ARCH_SOURCE=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "NODE_ARCH_SOURCE=%PROCESSOR_ARCHITEW6432%"

if /I "%NODE_ARCH_SOURCE%"=="ARM64" (
  set "NODE_ARCH=arm64"
  exit /b 0
)
if /I "%NODE_ARCH_SOURCE%"=="AMD64" (
  set "NODE_ARCH=x64"
  exit /b 0
)
if /I "%NODE_ARCH_SOURCE%"=="x86_64" (
  set "NODE_ARCH=x64"
  exit /b 0
)

call :LogError "Unsupported Windows architecture: %NODE_ARCH_SOURCE%"
exit /b 1

:InstallManagedNode
set "INSTALL_NODE_VERSION=%~1"
set "INSTALL_NODE_ROOT=%~2"

call :GetNodeArch
if errorlevel 1 exit /b 1

set "NODE_DIR_NAME=node-v%INSTALL_NODE_VERSION%-win-%NODE_ARCH%"
set "NODE_DIR=%INSTALL_NODE_ROOT%\%NODE_DIR_NAME%"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_EXE=%NODE_DIR%\npm.cmd"

if exist "%NODE_EXE%" if exist "%NPM_EXE%" if not "%FORCE_NODE_DOWNLOAD%"=="1" (
  set "NODE_CMD=%NODE_EXE%"
  set "NPM_CMD=%NPM_EXE%"
  set "NODE_BIN_DIR=%NODE_DIR%"
  exit /b 0
)

if not exist "%INSTALL_NODE_ROOT%" mkdir "%INSTALL_NODE_ROOT%" >nul 2>nul
if errorlevel 1 (
  call :LogError "Failed to create Node.js install root: %INSTALL_NODE_ROOT%"
  exit /b 1
)

set "NODE_ZIP_NAME=%NODE_DIR_NAME%.zip"
set "NODE_ZIP_URL=https://nodejs.org/dist/v%INSTALL_NODE_VERSION%/%NODE_ZIP_NAME%"
set "NODE_ZIP_PATH=%INSTALL_NODE_ROOT%\%NODE_ZIP_NAME%"
set "NODE_EXTRACT_DIR=%INSTALL_NODE_ROOT%\extract-%NODE_DIR_NAME%"

call :LogInfo "Downloading Node.js v%INSTALL_NODE_VERSION% (%NODE_ARCH%)"
set "INSTALLER_ZIP_URL=%NODE_ZIP_URL%"
set "INSTALLER_ZIP_PATH=%NODE_ZIP_PATH%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri $env:INSTALLER_ZIP_URL -OutFile $env:INSTALLER_ZIP_PATH"
if errorlevel 1 (
  call :LogError "Failed to download Node.js from %NODE_ZIP_URL%"
  exit /b 1
)

if exist "%NODE_EXTRACT_DIR%" rmdir /s /q "%NODE_EXTRACT_DIR%"
if errorlevel 1 (
  call :LogError "Failed to remove temporary extraction directory: %NODE_EXTRACT_DIR%"
  exit /b 1
)
mkdir "%NODE_EXTRACT_DIR%" >nul 2>nul
if errorlevel 1 (
  call :LogError "Failed to create temporary extraction directory: %NODE_EXTRACT_DIR%"
  exit /b 1
)

call :LogInfo "Extracting Node.js"
set "INSTALLER_ZIP_PATH=%NODE_ZIP_PATH%"
set "INSTALLER_EXTRACT_DIR=%NODE_EXTRACT_DIR%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:INSTALLER_ZIP_PATH -DestinationPath $env:INSTALLER_EXTRACT_DIR -Force"
if errorlevel 1 (
  call :LogError "Failed to extract Node.js."
  exit /b 1
)

if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
if errorlevel 1 (
  call :LogError "Failed to replace existing Node.js directory: %NODE_DIR%"
  exit /b 1
)

move "%NODE_EXTRACT_DIR%\%NODE_DIR_NAME%" "%NODE_DIR%" >nul
if errorlevel 1 (
  call :LogError "Failed to install Node.js into %NODE_DIR%"
  exit /b 1
)

rmdir /s /q "%NODE_EXTRACT_DIR%" >nul 2>nul
del /q "%NODE_ZIP_PATH%" >nul 2>nul

if not exist "%NODE_EXE%" (
  call :LogError "Downloaded Node.js is missing node.exe: %NODE_EXE%"
  exit /b 1
)
if not exist "%NPM_EXE%" (
  call :LogError "Downloaded Node.js is missing npm.cmd: %NPM_EXE%"
  exit /b 1
)

set "NODE_CMD=%NODE_EXE%"
set "NPM_CMD=%NPM_EXE%"
set "NODE_BIN_DIR=%NODE_DIR%"
exit /b 0

:AddUserPathEntry
set "PATH_ENTRY=%~1"
if not defined PATH_ENTRY exit /b 0
if not exist "%PATH_ENTRY%\" exit /b 0

for %%I in ("%PATH_ENTRY%") do set "RESOLVED_PATH_ENTRY=%%~fI"
if "!RESOLVED_PATH_ENTRY:~-1!"=="\" set "RESOLVED_PATH_ENTRY=!RESOLVED_PATH_ENTRY:~0,-1!"

set "INSTALLER_PATH_ENTRY=%RESOLVED_PATH_ENTRY%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$entry = $env:INSTALLER_PATH_ENTRY.TrimEnd('\'); $current = [Environment]::GetEnvironmentVariable('Path', 'User'); $entries = @(); if ($current) { $entries = $current -split ';' | Where-Object { $_ -and $_.Trim() } }; $exists = $entries | Where-Object { $_.TrimEnd('\').Equals($entry, [System.StringComparison]::OrdinalIgnoreCase) }; if ($exists) { Write-Host ('[INFO] User PATH already contains ' + $entry) -ForegroundColor Green } else { $next = if ($current) { $current + ';' + $entry } else { $entry }; [Environment]::SetEnvironmentVariable('Path', $next, 'User'); Write-Host ('[INFO] Added to user PATH: ' + $entry) -ForegroundColor Green }"
if errorlevel 1 (
  call :LogError "Failed to update user PATH: %RESOLVED_PATH_ENTRY%"
  exit /b 1
)

echo ;%PATH%; | find /I ";%RESOLVED_PATH_ENTRY%;" >nul
if errorlevel 1 set "PATH=%RESOLVED_PATH_ENTRY%;%PATH%"
exit /b 0

:LogInfo
echo [INFO] %~1
exit /b 0

:LogWarn
echo [WARN] %~1
exit /b 0

:LogError
echo [ERROR] %~1
exit /b 0

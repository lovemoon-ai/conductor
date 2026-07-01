#requires -Version 5.1
[CmdletBinding()]
param(
  [string] $NodePath,
  [string] $PnpmPath,
  [switch] $SkipBuild,
  [switch] $NoNativeRebuild,
  [switch] $NoPathUpdate
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingFile {
  param(
    [string] $ExplicitPath,
    [string] $CommandName,
    [string[]] $FallbackPaths
  )

  if ($ExplicitPath) {
    $resolved = Resolve-Path -LiteralPath $ExplicitPath -ErrorAction Stop
    return $resolved.Path
  }

  $commands = @(Get-Command $CommandName -All -ErrorAction SilentlyContinue)
  if ($commands.Count -gt 0) {
    $preferred = $commands | Where-Object {
      $_.Source -and ($_.Source.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase) -or
        $_.Source.EndsWith(".cmd", [System.StringComparison]::OrdinalIgnoreCase) -or
        $_.Source.EndsWith(".bat", [System.StringComparison]::OrdinalIgnoreCase))
    } | Select-Object -First 1
    if ($preferred -and $preferred.Source) {
      return $preferred.Source
    }
    if ($commands[0].Source) {
      return $commands[0].Source
    }
  }

  foreach ($candidate in $FallbackPaths) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Could not find $CommandName. Install it, add it to PATH, or pass -$($CommandName.Substring(0,1).ToUpper())$($CommandName.Substring(1))Path."
}

function Invoke-Step {
  param(
    [string] $Label,
    [string] $FilePath,
    [string[]] $Arguments,
    [string] $WorkingDirectory
  )

  Write-Host "==> $Label"
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    if ($null -ne $exitCode -and $exitCode -ne 0) {
      throw "$Label failed with exit code $exitCode"
    }
  } finally {
    Pop-Location
  }
}

function Add-UserPathEntry {
  param([string] $PathEntry)

  $resolvedEntry = (Resolve-Path -LiteralPath $PathEntry).Path.TrimEnd("\")
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($current) {
    $entries = $current -split ";" | Where-Object { $_ -and $_.Trim() }
  }
  $exists = $entries | Where-Object {
    $_.TrimEnd("\").Equals($resolvedEntry, [System.StringComparison]::OrdinalIgnoreCase)
  }
  if ($exists) {
    Write-Host "==> User PATH already contains $resolvedEntry"
    return
  }

  $next = if ($current) { "$current;$resolvedEntry" } else { $resolvedEntry }
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  if (-not (($env:Path -split ";") | Where-Object {
    $_.TrimEnd("\").Equals($resolvedEntry, [System.StringComparison]::OrdinalIgnoreCase)
  })) {
    $env:Path = "$resolvedEntry;$env:Path"
  }
  Write-Host "==> Added to user PATH: $resolvedEntry"
  Write-Host "    Open a new terminal for PATH changes to take effect everywhere."
}

if ($env:OS -ne "Windows_NT") {
  throw "scripts/install.ps1 is intended for Windows."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path
$binDir = Join-Path $rootDir "bin"
$cliEntry = Join-Path $rootDir "cli\bin\conductor.js"

if (-not (Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
  throw "Conductor CLI entry not found: $cliEntry"
}

$nodeFallbacks = @(
  (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
)
$pnpmFallbacks = @(
  (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd")
)

$node = Resolve-ExistingFile -ExplicitPath $NodePath -CommandName "node" -FallbackPaths $nodeFallbacks
$pnpm = Resolve-ExistingFile -ExplicitPath $PnpmPath -CommandName "pnpm" -FallbackPaths $pnpmFallbacks

Write-Host "==> Repo: $rootDir"
Write-Host "==> Node: $node"
Write-Host "==> pnpm: $pnpm"

if (-not $SkipBuild) {
  foreach ($packageDir in @("modules\chat-web", "modules\ai-sdk", "modules\conductor-sdk")) {
    Invoke-Step "Installing $packageDir dependencies" $pnpm @("--dir", (Join-Path $rootDir $packageDir), "install") $rootDir
    Invoke-Step "Building $packageDir" $pnpm @("--dir", (Join-Path $rootDir $packageDir), "run", "build") $rootDir
  }

  Invoke-Step "Installing CLI dependencies" $pnpm @("--dir", (Join-Path $rootDir "cli"), "install") $rootDir

  if (-not $NoNativeRebuild) {
    Invoke-Step "Rebuilding node-pty native binding" $pnpm @("--dir", (Join-Path $rootDir "cli"), "rebuild", "node-pty") $rootDir
  }
}

New-Item -ItemType Directory -Path $binDir -Force | Out-Null

$cmdShim = @"
@echo off
setlocal
set "NODE_EXE=$node"
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
"%NODE_EXE%" "%REPO_ROOT%\cli\bin\conductor.js" %*
exit /b %ERRORLEVEL%
"@

$psShim = @"
`$ErrorActionPreference = "Stop"
`$node = "$node"
`$repoRoot = (Resolve-Path -LiteralPath (Join-Path `$PSScriptRoot "..")).Path
& `$node (Join-Path `$repoRoot "cli\bin\conductor.js") @args
exit `$LASTEXITCODE
"@

$conductorCmd = Join-Path $binDir "conductor.cmd"
$conductorDevCmd = Join-Path $binDir "conductor-dev.cmd"
$conductorPs1 = Join-Path $binDir "conductor.ps1"

Set-Content -LiteralPath $conductorCmd -Value $cmdShim -Encoding ASCII
Set-Content -LiteralPath $conductorDevCmd -Value $cmdShim -Encoding ASCII
Set-Content -LiteralPath $conductorPs1 -Value $psShim -Encoding UTF8

Write-Host "==> Wrote CLI shims:"
Write-Host "    $conductorCmd"
Write-Host "    $conductorDevCmd"
Write-Host "    $conductorPs1"

if (-not $NoPathUpdate) {
  Add-UserPathEntry $binDir
}

Invoke-Step "Verifying conductor shim" $conductorCmd @("--version") $rootDir

Write-Host "==> Daemon launcher:"
Write-Host "    $scriptDir\run-conductor-daemon.bat"
Write-Host "==> Done."

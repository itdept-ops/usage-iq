<#
  Run-UsageIqReporter.ps1
  -----------------------
  Builds the Usage IQ reporter (Release) and runs it in watch mode, streaming your
  Claude Code / Codex usage to the dashboard. Move this file anywhere (e.g. your Desktop).

  KEY HANDLING (in priority order):
    1. -Key parameter
    2. $env:REPORTER_KEY environment variable
    3. a "reporter.key" file sitting next to this script
    4. prompt (with an option to save it to reporter.key for next time)
  The ingest key is a secret. If you let it save reporter.key, keep that file private.

  RUN IT:
    Right-click this file  ->  "Run with PowerShell"
    or from a terminal:    powershell -ExecutionPolicy Bypass -File .\Run-UsageIqReporter.ps1
    one-shot (no loop):    ...\Run-UsageIqReporter.ps1 -Once
    skip the rebuild:      ...\Run-UsageIqReporter.ps1 -NoBuild

  Full guide: docs/reporter.md  ·  https://github.com/itdept-ops/usage-iq
#>
param(
    [string]$Url      = "https://usageiq.online",
    [string]$RepoRoot = "",                       # auto-detected if blank (see below)
    [string]$Key      = $env:REPORTER_KEY,
    [string]$Machine  = $env:COMPUTERNAME,
    [int]   $Batch    = 1000,
    [int]   $Interval = 1800,
    [switch]$Once,
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# --- find the usage-iq checkout (script lives in it, or you're running from it, or pass -RepoRoot) ---
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    if     (Test-Path (Join-Path $PSScriptRoot 'src\Reporter')) { $RepoRoot = $PSScriptRoot }
    elseif (Test-Path (Join-Path (Get-Location) 'src\Reporter')) { $RepoRoot = (Get-Location).Path }
    else { Fail "Couldn't find the usage-iq checkout. Pass -RepoRoot <path-to-usage-iq> (or edit the default)." }
}

# --- resolve the ingest key (param > env > key file > prompt) ---
# Stored OUTSIDE any repo (~/.usage-iq) so it can never be swept into a commit.
$keyDir  = Join-Path $env:USERPROFILE ".usage-iq"
$keyFile = Join-Path $keyDir "reporter.key"
$legacyKeyFile = Join-Path $PSScriptRoot "reporter.key"   # older versions saved next to the script
if ([string]::IsNullOrWhiteSpace($Key) -and (Test-Path $keyFile))       { $Key = (Get-Content $keyFile -Raw).Trim() }
if ([string]::IsNullOrWhiteSpace($Key) -and (Test-Path $legacyKeyFile)) { $Key = (Get-Content $legacyKeyFile -Raw).Trim() }
if ([string]::IsNullOrWhiteSpace($Key)) {
    $secure = Read-Host "Enter your Usage IQ ingest key (Dashboard -> Reporter -> Generate key)" -AsSecureString
    $Key = [System.Net.NetworkCredential]::new("", $secure).Password
    if ([string]::IsNullOrWhiteSpace($Key)) { Fail "No key provided." }
    if ((Read-Host "Save it to '$keyFile' so you don't get asked again? (y/N)") -match '^(y|yes)$') {
        New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
        Set-Content -Path $keyFile -Value $Key -NoNewline -Encoding ascii
        Write-Host "Saved to $keyFile. Treat it as a password - keep it private." -ForegroundColor Yellow
    }
}

# --- sanity checks ---
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Fail "The .NET SDK ('dotnet') isn't on your PATH. Install .NET 9 SDK." }
$proj = Join-Path $RepoRoot "src\Reporter"
if (-not (Test-Path $proj)) { Fail "Reporter project not found at '$proj'. Pass -RepoRoot <path-to-usage-iq>." }

# --- build ---
if (-not $NoBuild) {
    Step "Building reporter (Release)..."
    dotnet build $proj -c Release --nologo
    if ($LASTEXITCODE -ne 0) { Fail "Build failed (is a reporter already running and locking the exe? Stop it first)." }
}

$exe = Join-Path $proj "bin\Release\net9.0\usage-iq-reporter.exe"
if (-not (Test-Path $exe)) { Fail "Built executable not found at '$exe'." }

# --- run ---
if ($Url -match '^http://' -and $Url -notmatch '://(localhost|127\.0\.0\.1|\[::1\])') {
    Write-Host "WARNING: --url is http:// to a non-local host; the key travels in cleartext. Prefer https." -ForegroundColor Yellow
}
$reporterArgs = @("--url", $Url, "--key", $Key, "--machine", $Machine, "--batch", "$Batch", "--interval", "$Interval")
if ($Once) { $reporterArgs += "--once" }

Step "Starting reporter -> $Url  (machine: $Machine)$(if ($Once) { ' [one-shot]' } else { ' [watch - Ctrl+C to stop]' })"
& $exe @reporterArgs
exit $LASTEXITCODE

$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 6490
$Url = "http://127.0.0.1:$Port"
$ServerScript = Join-Path $AppDir "lottery_ui_server.mjs"
$LogPath = Join-Path $AppDir "launcher.log"

function Write-LauncherLog($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] $message" -Encoding UTF8
}

function Test-LottoUiServer {
    try {
        $response = Invoke-WebRequest -Uri "$Url/api/status" -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Show-LottoMessage($message) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.Popup($message, 8, "Lotto UI", 48)
    } catch {
        Write-LauncherLog "Popup failed: $($_.Exception.Message)"
    }
}

try {
    Write-LauncherLog "Launcher started."

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) {
        Write-LauncherLog "Node.js not found in PATH."
        Show-LottoMessage "Node.js was not found. Please install Node.js or run from Codex."
        exit 1
    }

    $nodePath = $nodeCommand.Source
    Write-LauncherLog "Using node: $nodePath"

    if (-not (Test-Path -LiteralPath $ServerScript)) {
        Write-LauncherLog "Server script missing: $ServerScript"
        Show-LottoMessage "UI server file was not found. See F:\649\launcher.log"
        exit 1
    }

    if (-not (Test-LottoUiServer)) {
        Write-LauncherLog "Server is not running. Starting server."
        Start-Process -FilePath $nodePath `
            -ArgumentList @($ServerScript, "--open=false") `
            -WorkingDirectory $AppDir `
            -WindowStyle Hidden

        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 300
            if (Test-LottoUiServer) {
                $ready = $true
                break
            }
        }

        if (-not $ready) {
            Write-LauncherLog "Server startup timed out."
            Show-LottoMessage "Lotto UI startup timed out. See F:\649\launcher.log"
            exit 1
        }
    } else {
        Write-LauncherLog "Server already running."
    }

    Write-LauncherLog "Opening browser: $Url"
    Start-Process $Url
    Write-LauncherLog "Launcher completed."
} catch {
    Write-LauncherLog "Launcher failed: $($_.Exception.Message)"
    Show-LottoMessage "Lotto UI failed to start. See F:\649\launcher.log"
    exit 1
}

# ccoc gateway tray monitor.
#
# Shows a system-tray icon for the ccoc gateway: green when serving, gray when
# paused or down. A single click pauses/resumes serving - the gateway process
# itself keeps running either way (it just stops answering model requests while
# paused). Hovering shows a compact stats tooltip. Polls every 3 seconds.
# Launch with `ccoc tray`, or it is auto-launched by `ccoc serve`.
#
# The gateway port comes from ~/.config/ccoc/config.json (port), falling back
# to 6767 to match `ccoc install-service`'s default.

$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-ConfigPath {
  if ($env:XDG_CONFIG_HOME) { return Join-Path $env:XDG_CONFIG_HOME "ccoc\config.json" }
  return Join-Path $env:USERPROFILE ".config\ccoc\config.json"
}

function Get-GatewayPort {
  try {
    $config = Get-Content -LiteralPath (Get-ConfigPath) -Raw | ConvertFrom-Json
    if ($config.port) { return [int]$config.port }
  } catch {}
  return 6767
}

$Port = Get-GatewayPort
$Base = "http://127.0.0.1:$Port"
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$ccocBin = Join-Path $PSScriptRoot "..\bin\ccoc.cjs"

# Keys ccoc keeps in ~/.claude/settings.json "env" to route Claude Code
# through the LOCAL gateway. Serving (resume) verifies them; pausing strips
# them so Claude Code falls back to the user-level env (e.g. a shared remote
# gateway) while the local gateway process stays up but paused.
$GatewayEnvKeys = @(
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"
)

function Get-ClaudeSettingsPath {
  return Join-Path $env:USERPROFILE ".claude\settings.json"
}

function Get-ClaudeSettings {
  try {
    return Get-Content -LiteralPath (Get-ClaudeSettingsPath) -Raw | ConvertFrom-Json -AsHashtable
  } catch {
    return @{}
  }
}

function Set-ClaudeSettings($Settings) {
  # settings.json can be locked by a running Claude Code session: retry a few
  # times, then give up rather than crash the tray.
  $json = $Settings | ConvertTo-Json -Depth 8
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      [System.IO.File]::WriteAllText((Get-ClaudeSettingsPath), $json, [System.Text.UTF8Encoding]::new($false))
      return
    } catch {
      if ($attempt -lt 4) { Start-Sleep -Milliseconds 300 }
    }
  }
}

function Remove-GatewayEnv {
  $settings = Get-ClaudeSettings
  $env = @{}
  if ($settings.env) { $env = $settings.env }
  foreach ($key in $GatewayEnvKeys) {
    if ($env.ContainsKey($key)) { $env.Remove($key) | Out-Null }
  }
  if ($env.Count -eq 0) { $settings.Remove("env") | Out-Null } else { $settings["env"] = $env }
  Set-ClaudeSettings $settings
}

function Add-GatewayEnv {
  $settings = Get-ClaudeSettings
  if (-not $settings.env) { $settings["env"] = @{} }
  $settings["env"]["ANTHROPIC_BASE_URL"] = $Base
  $settings["env"]["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1"
  $settings["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = "1000000"
  $settings["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = "1000000"
  $settings["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "32000"
  $settings["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = "95"
  Set-ClaudeSettings $settings
}

# Claude Code caches the gateway's /v1/models per baseUrl and OAuth-logged-in
# users skip discovery, so switching gateways (local <-> remote) must rewrite
# the cache or Claude Code shows an empty model list. Generous timeout: the
# shared gateway machine can be slow to answer.
function Update-ModelCache($BaseUrl) {
  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/v1/models" -UseBasicParsing -TimeoutSec 30
    $data = ($response.Content | ConvertFrom-Json).data
    $cacheDir = Join-Path $env:USERPROFILE ".claude\cache"
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    @{
      baseUrl   = $BaseUrl
      fetchedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      models    = @($data | ForEach-Object { @{ id = $_.id; display_name = $_.display_name } })
    } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $cacheDir "gateway-models.json") -NoNewline
  } catch {}
}

# Singleton: the tray outlives the gateway process (it is spawned through a
# Start-Process wrapper), so a later gateway restart would otherwise leave a
# second icon behind. The newest tray stops any older instances.
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*ccoc-tray.ps1*'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

function Get-Json($Path) {
  try {
    $response = Invoke-WebRequest -Uri "$Base$Path" -UseBasicParsing -TimeoutSec 3
    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Post-Admin($Action) {
  try {
    return Invoke-RestMethod -Method Post -Uri "$Base/admin/$Action" -TimeoutSec 3
  } catch {
    return $null
  }
}

function Start-Gateway {
  # The gateway died completely (not just paused): relaunch it hidden.
  # --no-tray: the gateway must not spawn a second tray icon (this one stays).
  Start-Process powershell -ArgumentList "-NoProfile","-WindowStyle","Hidden","-Command",
    "Start-Process -WindowStyle Hidden -FilePath '$nodeExe' -ArgumentList '$ccocBin','serve','--port','$Port','--no-tray'" -WindowStyle Hidden
  Add-GatewayEnv
}

$Stats = $null
$Health = $null
$Paused = $false

function Refresh-State {
  $script:Health = Get-Json "/health"
  $status = Get-Json "/admin/status"
  $script:Paused = $null -ne $status -and $status.paused
}

function Stop-GatewayProcess {
  # Full stop: kill the gateway process itself (middle-click). The tray is
  # spawned through a Start-Process wrapper, so it survives and can restart it.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "ccoc\.cjs.* serve" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

function New-Tooltip {
  if ($Paused) {
    return "ccoc: paused (port $Port)`nclick to resume`nmiddle-click: stop gateway & exit"
  }
  if (-not $Health) {
    return "ccoc: off (port $Port)`nclick to start`nmiddle-click: exit tray"
  }
  $lines = @("ccoc: serving (port $Port)")
  if ($Stats) {
    $lines += "uptime $($Stats.uptimeSeconds)s"
    $lines += "requests $($Stats.totals.requests) | errors $($Stats.totals.errors)"
    $lines += "active $($Stats.active) | bytes $($Stats.totals.bytes)"
  }
  $lines += "click to pause"
  $lines += "middle-click: stop gateway & exit"
  return ($lines -join "`n")
}

Refresh-State

# Generate on/off icons: a colored dot shows gateway state at a glance.
function New-StateIcon([System.Drawing.Color]$Color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush $Color
  $graphics.FillEllipse($brush, 6, 6, 20, 20)
  $graphics.Dispose()
  $brush.Dispose()
  $handle = $bmp.GetHicon()
  $bmp.Dispose()
  return [System.Drawing.Icon]::FromHandle($handle)
}

$iconRunning = New-StateIcon ([System.Drawing.Color]::LimeGreen)
$iconStopped = New-StateIcon ([System.Drawing.Color]::Gray)

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $(if ($Health -and -not $Paused) { $iconRunning } else { $iconStopped })
$tray.Text = New-Tooltip
$tray.Visible = $true

function Update-Tray {
  Refresh-State
  $tray.Icon = $(if ($Health -and -not $Paused) { $iconRunning } else { $iconStopped })
  $tray.Text = New-Tooltip
}

# Left click pauses/resumes serving; middle click stops the gateway process
# completely AND exits the tray app itself (full shutdown — the gateway is
# relaunched later via the scheduled task at logon, the Startup entry, or
# `ccoc serve`). Pausing/stopping strips the local-gateway env from
# settings.json and points the model cache at the user-level remote gateway
# (if any); resuming/starting re-applies the local env and cache. No context
# menu.
$tray.Add_MouseClick({
  try {
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Middle) {
      if ($Health -or $Paused) {
        Stop-GatewayProcess
        Remove-GatewayEnv
        $remote = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
        if ($remote) { Update-ModelCache $remote }
      }
      # end the message loop so the tray process exits
      $form.Close()
      return
    }
    if ($_.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    if ($Health) {
      Post-Admin "pause" | Out-Null
      Remove-GatewayEnv
      $remote = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
      if ($remote) { Update-ModelCache $remote }
    } else {
      $resumed = Post-Admin "resume"
      if ($resumed) {
        Update-ModelCache $Base
        Add-GatewayEnv
      } else {
        Start-Gateway
        # wait for the relaunched gateway to come up, then point claude at it
        for ($i = 0; $i -lt 20 -and -not (Get-Json "/health"); $i++) {
          Start-Sleep -Milliseconds 400
        }
        Update-ModelCache $Base
        Add-GatewayEnv
      }
    }
    Start-Sleep -Milliseconds 600
    Update-Tray
  } catch {}
})

# Hidden owner form gives the tray a real message pump.
$form = New-Object System.Windows.Forms.Form
$form.WindowState = 'Minimized'
$form.ShowInTaskbar = $false
$form.Add_Load({ $form.Hide() })

$tray.ShowBalloonTip(3000, "ccoc gateway", "Gateway on port $Port - $Base", [System.Windows.Forms.ToolTipIcon]::Info)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Tray })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)

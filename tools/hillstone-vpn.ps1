param(
  [string]$Action = 'start',
  [switch]$NoBrowser,
  [switch]$Detach
)

$ErrorActionPreference = 'Stop'

$ActionAliases = @{
  'on' = 'start'
  'off' = 'stop'
  'query' = 'status'
  'test' = 'target-test'
}
$ValidActions = @('start', 'stop', 'restart', 'status', 'target-test')
$Action = $Action.Trim().ToLowerInvariant()
if ($ActionAliases.ContainsKey($Action)) { $Action = $ActionAliases[$Action] }
if ($Action -notin $ValidActions) { throw "Unsupported action '$Action'. Valid actions: $($ValidActions -join ', ')" }

$SshExe = Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
if (-not (Test-Path $SshExe)) {
  $found = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $found) { throw 'OpenSSH ssh.exe was not found.' }
  $SshExe = $found.Source
}

$RemoteUser = if ($env:CAM_HILLSTONE_SSH_USER) { $env:CAM_HILLSTONE_SSH_USER } else { 'dq' }
$RemoteHost = if ($env:CAM_HILLSTONE_SSH_HOST) { $env:CAM_HILLSTONE_SSH_HOST } else { '172.20.30.201' }
$RemotePort = if ($env:CAM_HILLSTONE_SSH_PORT) { $env:CAM_HILLSTONE_SSH_PORT } else { '1204' }
$Remote = "$RemoteUser@$RemoteHost"
$RemoteComposeDir = if ($env:CAM_HILLSTONE_REMOTE_DIR) { $env:CAM_HILLSTONE_REMOTE_DIR } else { '/home/dq/work/code/system-of-administration/cloud-artifact-management' }
$RemoteCompose = "cd $RemoteComposeDir && docker compose --env-file .env"
$HillstoneContainer = if ($env:CAM_HILLSTONE_CONTAINER) { $env:CAM_HILLSTONE_CONTAINER } else { 'cam-hillstone-vpn' }
$HillstoneService = if ($env:CAM_HILLSTONE_SERVICE) { $env:CAM_HILLSTONE_SERVICE } else { 'hillstone-vpn' }
$TargetUrl = if ($env:CAM_HILLSTONE_TARGET_URL) { $env:CAM_HILLSTONE_TARGET_URL } else { 'http://172.22.5.177/offlinePackage/cloud-xbd/ustor4.2.1/anolis-x86_rpm.tar.gz' }
$RouteService = if ($env:CAM_HILLSTONE_ROUTE_SERVICE) { $env:CAM_HILLSTONE_ROUTE_SERVICE } else { 'cam-hillstone-route.service' }

$LocalNoVncPort = if ($env:CAM_HILLSTONE_LOCAL_NOVNC_PORT) { [int]$env:CAM_HILLSTONE_LOCAL_NOVNC_PORT } else { 16081 }
$LocalWebPort = if ($env:CAM_HILLSTONE_LOCAL_WEB_PORT) { [int]$env:CAM_HILLSTONE_LOCAL_WEB_PORT } else { 18081 }
$LocalSocksPort = if ($env:CAM_HILLSTONE_LOCAL_SOCKS_PORT) { [int]$env:CAM_HILLSTONE_LOCAL_SOCKS_PORT } else { 11081 }
$TunnelPidFile = Join-Path $env:TEMP 'cam-hillstone-vpn-tunnel.pid'
$TunnelOutFile = Join-Path $env:TEMP 'cam-hillstone-vpn-tunnel.out.log'
$TunnelErrFile = Join-Path $env:TEMP 'cam-hillstone-vpn-tunnel.err.log'

function Write-Info { param([string]$Message); Write-Host "[hillstone-vpn] $Message" }

function Invoke-RemoteCommand {
  param([string]$Command)
  & $SshExe '-p' $RemotePort '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=10' "$Remote" $Command
  if ($LASTEXITCODE -ne 0) { throw "Remote command failed: $Command" }
}

function Invoke-RemoteScript {
  param([string]$Script)
  $normalized = $Script -replace "`r`n", "`n"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalized))
  & $SshExe '-p' $RemotePort '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=10' "$Remote" "echo $encoded | base64 -d | bash"
  if ($LASTEXITCODE -ne 0) { throw 'Remote script failed.' }
}

function Get-TunnelCandidates {
  $pids = New-Object System.Collections.Generic.List[int]
  if (Test-Path $TunnelPidFile) {
    $value = Get-Content $TunnelPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($value -as [int]) {
      $process = Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue
      if ($process) { [void]$pids.Add([int]$process.Id) }
    }
  }
  $sshProcesses = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -match [regex]::Escape("$LocalNoVncPort`:127.0.0.1:16080") -and
      $_.CommandLine -match [regex]::Escape($RemoteHost)
    }
  foreach ($process in $sshProcesses) { [void]$pids.Add([int]$process.ProcessId) }
  return @($pids | Sort-Object -Unique)
}

function Stop-Tunnel {
  foreach ($pidValue in (Get-TunnelCandidates)) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    Write-Info "Stopped local SSH tunnel PID $pidValue."
  }
  Remove-Item $TunnelPidFile, $TunnelOutFile, $TunnelErrFile -Force -ErrorAction SilentlyContinue
}

function Test-LocalPortFree { param([int]$Port)
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($listeners) { throw "Local port $Port is already in use." }
}

function Start-Tunnel {
  Stop-Tunnel
  Test-LocalPortFree $LocalNoVncPort
  Test-LocalPortFree $LocalWebPort
  Test-LocalPortFree $LocalSocksPort
  $arguments = @(
    '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-L', "$LocalNoVncPort`:127.0.0.1:16080",
    '-L', "$LocalWebPort`:127.0.0.1:18080",
    '-L', "$LocalSocksPort`:127.0.0.1:11080",
    '-p', $RemotePort, $Remote
  )
  $process = Start-Process -FilePath $SshExe -ArgumentList $arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $TunnelOutFile -RedirectStandardError $TunnelErrFile
  Start-Sleep -Seconds 2
  if ($process.HasExited) {
    $errorText = if (Test-Path $TunnelErrFile) { (Get-Content $TunnelErrFile -Raw).Trim() } else { '' }
    if (-not $errorText) { $errorText = "ssh exited with code $($process.ExitCode)" }
    throw "Failed to start local SSH tunnel. $errorText"
  }
  Set-Content -Path $TunnelPidFile -Value $process.Id
  Write-Info "Local SSH tunnel is up (PID $($process.Id))."
}

function Show-AccessInfo {
  Write-Info "noVNC: http://127.0.0.1:$LocalNoVncPort/vnc.html?autoconnect=1&resize=scale"
  Write-Info "Web:   http://127.0.0.1:$LocalWebPort/"
  Write-Info "SOCKS: 127.0.0.1:$LocalSocksPort"
}

function Start-Session {
  param([switch]$Recreate)
  $upCommand = if ($Recreate) { "$RemoteCompose up -d --force-recreate $HillstoneService" } else { "$RemoteCompose up -d $HillstoneService" }
  Invoke-RemoteCommand $upCommand
  Invoke-RemoteCommand "sudo -n systemctl restart $RouteService"
  Start-Tunnel
  Show-AccessInfo
  if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:$LocalNoVncPort/vnc.html?autoconnect=1&resize=scale" | Out-Null
    Write-Info 'Opened the noVNC page in the default browser.'
  }
  if ($Detach) { Write-Info 'Tunnel left running in the background. Use stop to close it.'; return }
  try { [void](Read-Host 'Press Enter after finishing VPN login') } finally { Stop-Tunnel }
}

function Show-Status {
  Invoke-RemoteCommand "$RemoteCompose ps $HillstoneService"
  Invoke-RemoteCommand "sudo -n systemctl is-active $RouteService"
  $pids = Get-TunnelCandidates
  if ($pids) { Write-Info "Local SSH tunnel PID(s): $($pids -join ', ')" } else { Write-Info 'No local SSH tunnel is running.' }
  Show-AccessInfo
}

function Test-Target {
  $target = $TargetUrl.Replace("'", "'\\''")
  $script = @"
set +e
echo TARGET=$TargetUrl
sudo -n docker exec $HillstoneContainer sh -lc 'ip route'
  sudo -n docker exec $HillstoneContainer sh -lc "curl -fsSIL --connect-timeout 5 --max-time 15 '$target' 2>&1"
exit 0
"@
  Invoke-RemoteScript $script
}

switch ($Action) {
  'start' { Start-Session }
  'stop' {
    Stop-Tunnel
    Invoke-RemoteCommand "sudo -n systemctl stop $RouteService || true"
    Invoke-RemoteCommand "$RemoteCompose stop $HillstoneService"
    Write-Info 'Remote Hillstone container stopped.'
  }
  'restart' { Stop-Tunnel; Start-Session -Recreate }
  'status' { Show-Status }
  'target-test' { Test-Target }
}

<#
  OpenAgile watchdog.

  Why: AI agents (and humans) sometimes launch a long-lived server
  (`npm run dev`, `npm run preview`, `vite`, `node src/server.mjs`) from a
  tool call that waits for the process to exit. The call never returns, the
  agent stalls, and a stray server keeps a port busy for hours.

  This script sweeps the process table, and kills any *server launcher* that
  has been alive longer than the threshold while NOT being an approved
  server. Approved = listening on a whitelisted port, living under a
  whitelisted project path, or being an ancestor/descendant of such a
  process (so `node --watch` wrappers and `esbuild` children survive).

  Usage:
    watchdog.ps1                       # one sweep (default)
    watchdog.ps1 -DryRun               # report only, kill nothing
    watchdog.ps1 -Loop                 # re-invoke itself every N minutes
    watchdog.ps1 -Install              # register a Scheduled Task (every N min)
    watchdog.ps1 -Uninstall            # remove the Scheduled Task
    watchdog.ps1 -ThresholdMinutes 5 -IntervalMinutes 2
#>
[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$Loop,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$DryRun,
    [int]$ThresholdMinutes = 5,
    [int]$IntervalMinutes = 2,
    [string]$LogPath
)

$ErrorActionPreference = 'SilentlyContinue'
$script:ScriptPath = $PSCommandPath
$script:TaskName = 'OpenAgile-Watchdog'

if (-not $LogPath) { $LogPath = Join-Path $PSScriptRoot 'logs\watchdog.log' }
$script:LogPath = $LogPath
$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# Ports that always belong to a real, wanted server. 4321 is the documented
# sandbox port agents may serve a build on for visual checks. A wanted server
# always listens on one of these, so exemption is decided by port alone --
# matching on project paths used to let any stray port inside those trees live.
$WhitelistPorts = @(8787, 3000, 4173, 5173, 8011, 8969, 4321)
# Agent/MCP infrastructure: never a stray, never touched.
$InfraPatterns = @('codegraph', 'lsp-daemon', 'blender-mcp', 'figma-developer-mcp', '@playwright/mcp', 'oh-my-openagent', 'opencode\.exe', 'watchdog\.ps1')
# Command lines that mean "this process is a server launcher".
$ServerPatterns = @(
    'run\s+(dev|preview|start|serve)\b',
    'npm-cli\.js"?\s+(run|exec)',
    'npx-cli\.js"?\s+.*\bvite\b',
    'vite\\bin\\vite\.js',
    '\bvite\.exe\b',
    '\bvite\s+(preview|dev)\b',
    'src[\\/]server\.mjs',
    'http\.server',
    'http-server',
    'live-server'
)

function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Format-Cmd([string]$cmd) {
    if (-not $cmd) { return '<no command line>' }
    $c = $cmd -replace '\s+', ' '
    if ($c.Length -gt 150) { $c = $c.Substring(0, 150) + '...' }
    return $c
}

function Invoke-Sweep {
    $now = Get-Date
    $all = Get-CimInstance Win32_Process
    $byId = @{}
    foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }

    $childrenOf = @{}
    foreach ($p in $all) {
        $key = [int]$p.ParentProcessId
        if (-not $childrenOf.ContainsKey($key)) { $childrenOf[$key] = New-Object 'System.Collections.Generic.List[int]' }
        $childrenOf[$key].Add([int]$p.ProcessId)
    }

    $exempt = New-Object 'System.Collections.Generic.HashSet[int]'
    $listeners = Get-NetTCPConnection -State Listen
    foreach ($l in $listeners) {
        if ($WhitelistPorts -contains [int]$l.LocalPort) { [void]$exempt.Add([int]$l.OwningProcess) }
    }

    # A process is exempt if an ancestor or descendant owns a whitelisted port.
    $roots = @($exempt)
    foreach ($root in $roots) {
        $walked = New-Object 'System.Collections.Generic.HashSet[int]'
        [void]$walked.Add($root)
        $cur = $byId[$root]
        while ($cur -and $cur.ParentProcessId) {
            $ppid = [int]$cur.ParentProcessId
            if ($ppid -le 0 -or -not $walked.Add($ppid)) { break }
            [void]$exempt.Add($ppid)
            $cur = $byId[$ppid]
        }
    }
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    foreach ($root in @($exempt)) { $queue.Enqueue($root) }
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if (-not $childrenOf.ContainsKey($id)) { continue }
        foreach ($child in $childrenOf[$id]) {
            if ($exempt.Add($child)) { $queue.Enqueue($child) }
        }
    }

    $killed = 0
    $kept = 0
    foreach ($p in $all) {
        $cmd = $p.CommandLine
        if (-not $cmd) { continue }
        $age = ($now - $p.CreationDate).TotalMinutes
        if ($age -lt $ThresholdMinutes) { continue }

        $isInfra = $false
        foreach ($pat in $InfraPatterns) { if ($cmd -match $pat) { $isInfra = $true; break } }
        if ($isInfra) { continue }

        $isServer = $false
        foreach ($pat in $ServerPatterns) { if ($cmd -match $pat) { $isServer = $true; break } }
        if (-not $isServer) { continue }

        $isExempt = $exempt.Contains([int]$p.ProcessId)

        if ($isExempt) {
            $kept++
            Write-Log ('KEEP   [{0,6:N1} min] PID {1} :: {2}' -f $age, $p.ProcessId, (Format-Cmd $cmd))
            continue
        }

        if ($DryRun) {
            Write-Log ('DRYRUN [{0,6:N1} min] PID {1} (would kill) :: {2}' -f $age, $p.ProcessId, (Format-Cmd $cmd))
            $killed++
            continue
        }

        # Children first so wrappers do not respawn the server.
        $victims = New-Object 'System.Collections.Generic.List[int]'
        $seen = New-Object 'System.Collections.Generic.HashSet[int]'
        $dq = New-Object 'System.Collections.Generic.Queue[int]'
        $dq.Enqueue([int]$p.ProcessId)
        while ($dq.Count -gt 0) {
            $id = $dq.Dequeue()
            if (-not $seen.Add($id)) { continue }
            $victims.Add($id)
            if ($childrenOf.ContainsKey($id)) { foreach ($c in $childrenOf[$id]) { $dq.Enqueue($c) } }
        }
        $victims.Reverse()
        foreach ($id in $victims) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        $killed++
        Write-Log ('KILL   [{0,6:N1} min] PID {1} (tree {2} procs) :: {3}' -f $age, $p.ProcessId, $victims.Count, (Format-Cmd $cmd))
    }

    $summary = if ($DryRun) { 'sweep complete (dry-run): {0} candidate(s), {1} kept' -f $killed, $kept } else { 'sweep complete: {0} killed, {1} kept' -f $killed, $kept }
    Write-Log $summary
}

if ($Uninstall) {
    schtasks /Delete /TN $script:TaskName /F | Out-Null
    Write-Log "scheduled task '$($script:TaskName)' removed"
    exit 0
}

if ($Install) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Once -ThresholdMinutes {1}' -f $script:ScriptPath, $ThresholdMinutes)
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 90) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Log "scheduled task '$($script:TaskName)' installed (every $IntervalMinutes min, threshold ${ThresholdMinutes}min, 90s execution limit, overlap ignored, runs on battery)"
    exit 0
}

if ($Loop) {
    Write-Log "watchdog loop starting (every $IntervalMinutes min, threshold ${ThresholdMinutes}min)"
    while ($true) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath -Once -ThresholdMinutes $ThresholdMinutes -IntervalMinutes $IntervalMinutes
        Start-Sleep -Seconds ($IntervalMinutes * 60)
    }
    exit 0
}

Invoke-Sweep

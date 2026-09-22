$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$line = 'cmd.exe /c cd /d "' + $here + '" && node --watch-path=src src/server.mjs > "' + (Join-Path $logDir 'harness.out.log') + '" 2>&1'
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; ProcessStartupInformation = $si } | Out-Null

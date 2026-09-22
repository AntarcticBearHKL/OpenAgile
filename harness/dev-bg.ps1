$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here 'logs'
$clientDir = Join-Path $here '..\client'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }

$harnessLine = 'cmd.exe /c cd /d "' + $here + '" && node --watch-path=src src/server.mjs > "' + (Join-Path $logDir 'harness.out.log') + '" 2>&1'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $harnessLine; ProcessStartupInformation = $si } | Out-Null

$clientLine = 'cmd.exe /c cd /d "' + $clientDir + '" && npm run build:watch > "' + (Join-Path $logDir 'client-build.out.log') + '" 2>&1'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $clientLine; ProcessStartupInformation = $si } | Out-Null
